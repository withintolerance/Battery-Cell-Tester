#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <esp_system.h>
#include <stdarg.h>

#include "tester_shared.h"

#if __has_include("wifi_defaults_private.h")
#include "wifi_defaults_private.h"
#endif

#ifndef DEFAULT_WIFI_SSID
#define DEFAULT_WIFI_SSID ""
#endif

#ifndef DEFAULT_WIFI_PASSWORD
#define DEFAULT_WIFI_PASSWORD ""
#endif

#ifndef DEFAULT_HUB_URL
#define DEFAULT_HUB_URL ""
#endif

#if !ENABLE_SERIAL_OUTPUT
#define Serial gNullSerial
#endif

void debugCheckpoint(const char *label) {
  DBG_CHK_PRINTF("[CHK] %s  heap=%u\n", label, static_cast<unsigned>(ESP.getFreeHeap()));
  if (ENABLE_DEBUG_SERIAL_CHECKPOINTS) {
    delay(300);
  }
}

static WebServer server(80);
static Preferences wifiPrefs;
static String savedSsid;
static String savedPassword;
static bool httpServerStarted = false;
static char gStatusJson[4096];
static bool gStatusJsonReady = false;
static uint32_t gLastStatusCollectMs = 0;
static uint32_t gHttpStartMs = 0;
static SystemSnapshot gSnapshot;
static constexpr uint32_t STATUS_COLLECT_INTERVAL_MS = 1500;
static constexpr uint32_t STATUS_COLLECT_WARMUP_MS = 2000;
static constexpr uint32_t WIFI_CONNECT_TIMEOUT_MS = 15000;
static constexpr uint32_t WIFI_RECONNECT_INTERVAL_MS = 10000;
static constexpr uint32_t RECOVERY_RETRY_INTERVAL_MS = 5000;
static constexpr uint8_t RECOVERY_MAX_ATTEMPTS = 12;
static constexpr wifi_power_t WIFI_TX_POWER_LIMIT = WIFI_POWER_8_5dBm; // Lower RF peaks to reduce 3.3V brownout risk.
static constexpr size_t HUB_URL_MAX_LEN = 96;
static constexpr size_t RECOVERY_ENDPOINT_MAX_LEN = HUB_URL_MAX_LEN + 48;
static constexpr size_t RECOVERY_REQUEST_MAX_LEN = 192;
static constexpr size_t RECOVERY_RESPONSE_MAX_LEN = 3072;
static constexpr size_t RECOVERY_ERROR_MAX_LEN = 160;
static char gHubBaseUrl[HUB_URL_MAX_LEN] = "";
static bool gRecoveryCheckDone = false;
static uint32_t gNextRecoveryAttemptMs = 0;
static uint8_t gRecoveryAttemptCount = 0;
static char gRecoveryEndpoint[RECOVERY_ENDPOINT_MAX_LEN] = "";
static char gRecoveryRequestBody[RECOVERY_REQUEST_MAX_LEN] = "";
static volatile bool gRecoveryRequestInFlight = false;
static volatile bool gRecoveryResponseReady = false;
static bool gRecoveryTransportOk = false;
static int gRecoveryStatusCode = 0;
static char gRecoveryResponseBody[RECOVERY_RESPONSE_MAX_LEN] = "";
static char gRecoveryError[RECOVERY_ERROR_MAX_LEN] = "";
static portMUX_TYPE gRecoveryMux = portMUX_INITIALIZER_UNLOCKED;
static uint32_t gWifiConnectStartedMs = 0;
static uint32_t gNextWifiReconnectMs = 0;
static bool gWifiConnectionFault = false;

static const char *jsonBool(bool value) {
  return value ? "true" : "false";
}

static size_t jsonWrite(char *buf, size_t bufSize, size_t offset, const char *fmt, ...) {
  if (offset >= bufSize) {
    return offset;
  }
  va_list args;
  va_start(args, fmt);
  const int written = vsnprintf(buf + offset, bufSize - offset, fmt, args);
  va_end(args);
  if (written < 0) {
    return offset;
  }
  return offset + static_cast<size_t>(written);
}

static size_t appendChannelJson(char *buf, size_t bufSize, size_t offset, const BqChannelReading &ch) {
  return jsonWrite(buf,
                   bufSize,
                   offset,
                   "{\"channel\":%u,\"label\":\"%s\",\"valid\":%s,"
                   "\"cellVoltageMv\":%u,\"cellPresent\":%s,\"chargeEnabled\":%s,"
                   "\"dischargeDuty\":%u,\"ichgLimitMa\":%u,"
                   "\"chgStatus\":\"%s\",\"vbusStatus\":\"%s\",\"fault0\":%u,"
                   "\"ibusMa\":%d,\"ibatMa\":%d,\"vbusMv\":%u,\"vbatMv\":%u,\"vsysMv\":%u,\"tdieApproxC\":%d}",
                   ch.channel,
                   ch.label,
                   jsonBool(ch.valid),
                   ch.cellVoltageMv,
                   jsonBool(ch.cellPresent),
                   jsonBool(ch.chargeEnabled),
                   ch.dischargeDuty,
                   ch.ichgLimitMa,
                   ch.chgStatusText,
                   ch.vbusStatusText,
                   ch.fault0,
                   ch.ibusMa,
                   ch.ibatMa,
                   ch.vbusMv,
                   ch.vbatMv,
                   ch.vsysMv,
                   ch.tdieApproxC);
}

static size_t appendInaJson(char *buf, size_t bufSize, size_t offset, const InaReading &ina) {
  char bus[16];
  char shunt[16];
  char current[16];
  char power[16];
  dtostrf(ina.busVolts, 1, 4, bus);
  dtostrf(ina.shuntMilliVolts, 1, 3, shunt);
  dtostrf(ina.currentAmps, 1, 4, current);
  dtostrf(ina.powerWatts, 1, 4, power);
  return jsonWrite(buf,
                   bufSize,
                   offset,
                   "{\"address\":\"0x%02X\",\"label\":\"%s\",\"valid\":%s,"
                   "\"busVolts\":%s,\"shuntMilliVolts\":%s,\"currentAmps\":%s,\"powerWatts\":%s}",
                   ina.address,
                   ina.label,
                   jsonBool(ina.valid),
                   bus,
                   shunt,
                   current,
                   power);
}

static size_t appendThermistorJson(char *buf, size_t bufSize, size_t offset, const ThermistorReading &t) {
  char volts[16];
  char ohms[20];
  char tempC[16];
  dtostrf(t.volts, 1, 4, volts);
  dtostrf(t.resistanceOhms, 1, 0, ohms);
  dtostrf(t.temperatureC, 1, 1, tempC);
  return jsonWrite(buf,
                   bufSize,
                   offset,
                   "{\"adsChannel\":%u,\"label\":\"%s\",\"valid\":%s,"
                   "\"volts\":%s,\"resistanceOhms\":%s,\"temperatureC\":%s}",
                   t.adsChannel,
                   t.label,
                   jsonBool(t.valid),
                   volts,
                   ohms,
                   tempC);
}

static const char *autoStateToString(AutoState state) {
  switch (state) {
    case AutoState::IDLE: return "IDLE";
    case AutoState::CHARGE_INITIAL: return "CHARGE_INITIAL";
    case AutoState::REST: return "REST";
    case AutoState::DISCHARGE: return "DISCHARGE";
    case AutoState::CHARGE_STORAGE: return "CHARGE_STORAGE";
    case AutoState::COMPLETE: return "COMPLETE";
    case AutoState::FAULT: return "FAULT";
    default: return "UNKNOWN";
  }
}

static size_t appendAutoJson(char *buf, size_t bufSize, size_t offset, const AutomationChannelState &autoState) {
  char cap[16];
  dtostrf(autoState.capacityMah, 1, 1, cap);
  return jsonWrite(buf,
                   bufSize,
                   offset,
                   "{\"state\":\"%s\",\"stateStartMs\":%u,\"capacityMah\":%s,\"restingVoltageMv\":%u,\"activeVoltageMv\":%u,\"faultReason\":\"%s\",\"cellId\":%u}",
                   autoStateToString(autoState.state),
                   autoState.stateStartMs,
                   cap,
                   autoState.restingVoltageMv,
                   autoState.activeVoltageMv,
                   autoState.faultReason,
                   autoState.cellId);
}

static bool serializeStatusJson(char *buf, size_t bufSize, const SystemSnapshot &snapshot) {
  const CellChemistryProfile &chemistry = batteryChemistryProfile();
  size_t offset = jsonWrite(buf,
                            bufSize,
                            0,
                            "{\"ok\":true,\"wifi\":{\"connected\":%s,\"ssid\":\"%s\",\"ip\":\"%s\",\"status\":\"%s\"},"
                            "\"system\":{\"fanOn\":%s,\"rs485Transmit\":%s,\"bootId\":%u,\"uptimeMs\":%u,\"resetReason\":\"%s\",\"i2c1Devices\":%d,\"i2c2Devices\":%d},"
                            "\"chemistry\":{\"id\":\"%s\",\"label\":\"%s\",\"maxChargeVoltageMv\":%u,\"dischargeCutoffMv\":%u,\"chargeCurrentMa\":%u},"
                            "\"channels\":[",
                            jsonBool(snapshot.wifiConnected),
                            snapshot.wifiSsid,
                            snapshot.wifiIp,
                            snapshot.wifiStatus,
                            jsonBool(snapshot.fanOn),
                            jsonBool(snapshot.rs485TransmitMode),
                            snapshot.bootId,
                            snapshot.uptimeMs,
                            snapshot.resetReason,
                            snapshot.i2c1DeviceCount,
                            snapshot.i2c2DeviceCount,
                            chemistry.id,
                            chemistry.label,
                            chemistry.maxChargeVoltageMv,
                            chemistry.dischargeCutoffMv,
                            chemistry.chargeCurrentMa);
  offset = appendChannelJson(buf, bufSize, offset, snapshot.channel1);
  offset = jsonWrite(buf, bufSize, offset, ",");
  offset = appendChannelJson(buf, bufSize, offset, snapshot.channel2);
  offset = jsonWrite(buf, bufSize, offset, "],\"ina\":[");
  offset = appendInaJson(buf, bufSize, offset, snapshot.ina1);
  offset = jsonWrite(buf, bufSize, offset, ",");
  offset = appendInaJson(buf, bufSize, offset, snapshot.ina2);
  offset = jsonWrite(buf, bufSize, offset, "],\"thermistors\":[");
  offset = appendThermistorJson(buf, bufSize, offset, snapshot.thermCellB);
  offset = jsonWrite(buf, bufSize, offset, ",");
  offset = appendThermistorJson(buf, bufSize, offset, snapshot.thermHeatsink);
  offset = jsonWrite(buf, bufSize, offset, ",");
  offset = appendThermistorJson(buf, bufSize, offset, snapshot.thermCellA);
  offset = jsonWrite(buf, bufSize, offset, ",");
  offset = appendThermistorJson(buf, bufSize, offset, snapshot.thermNc);
  offset = jsonWrite(buf, bufSize, offset, "],\"automation\":[");
  offset = appendAutoJson(buf, bufSize, offset, snapshot.auto1);
  offset = jsonWrite(buf, bufSize, offset, ",");
  offset = appendAutoJson(buf, bufSize, offset, snapshot.auto2);
  offset = jsonWrite(buf,
                     bufSize,
                     offset,
                     "],\"limits\":{\"cellPresentMinMv\":%u,\"ichgMinMa\":%u,\"ichgMaxMa\":%u,\"ichgStepMa\":%u}}",
                     CELL_PRESENT_MIN_MV,
                     BQ25622_ICHG_MIN_MA,
                     BQ25622_ICHG_MAX_MA,
                     BQ25622_ICHG_STEP_MA);
  return offset > 0 && offset < bufSize;
}

static void tickStatusJsonUpdate() {
  if (!httpServerStarted) {
    return;
  }
  if ((millis() - gHttpStartMs) < STATUS_COLLECT_WARMUP_MS) {
    return;
  }

  if (snapshotCollectionIdle()) {
    if ((gLastStatusCollectMs != 0) && ((millis() - gLastStatusCollectMs) < STATUS_COLLECT_INTERVAL_MS)) {
      return;
    }
    resetSnapshotCollection();
  }

  if (tickSnapshotCollection(gSnapshot)) {
    tickAutomation(gSnapshot);
    if (!serializeStatusJson(gStatusJson, sizeof(gStatusJson), gSnapshot)) {
      strncpy(gStatusJson, "{\"ok\":false,\"error\":\"status JSON buffer overflow\"}", sizeof(gStatusJson) - 1);
      gStatusJson[sizeof(gStatusJson) - 1] = '\0';
    }
    gStatusJsonReady = true;
    gLastStatusCollectMs = millis();
  }
}

static void addCorsHeaders() {
  server.sendHeader(F("Access-Control-Allow-Origin"), F("*"));
  server.sendHeader(F("Access-Control-Allow-Methods"), F("GET, POST, OPTIONS"));
  server.sendHeader(F("Access-Control-Allow-Headers"), F("Content-Type"));
}

static void sendJson(int code, const String &body) {
  addCorsHeaders();
  server.send(code, F("application/json"), body);
}

static void sendJsonBuffer(int code, const char *body) {
  addCorsHeaders();
  server.send(code, F("application/json"), body);
}

static void sendOptions() {
  addCorsHeaders();
  server.send(204);
}

static void loadWifiCredentials() {
  wifiPrefs.begin("wifi", true);
  savedSsid = wifiPrefs.getString("ssid", DEFAULT_WIFI_SSID);
  savedPassword = wifiPrefs.getString("pass", DEFAULT_WIFI_PASSWORD);
  wifiPrefs.end();
}

static bool saveWifiCredentials(const String &ssid, const String &password) {
  if ((ssid.length() == 0) || (ssid.length() > 32) || (password.length() > 64)) {
    return false;
  }
  wifiPrefs.begin("wifi", false);
  wifiPrefs.putString("ssid", ssid);
  wifiPrefs.putString("pass", password);
  wifiPrefs.end();
  savedSsid = ssid;
  savedPassword = password;
  return true;
}

static void clearWifiCredentials() {
  wifiPrefs.begin("wifi", false);
  wifiPrefs.clear();
  wifiPrefs.end();
  savedSsid = "";
  savedPassword = "";
  gHubBaseUrl[0] = '\0';
}

static void loadHubSettings() {
  wifiPrefs.begin("wifi", true);
  const String hub = wifiPrefs.getString("hub_url", DEFAULT_HUB_URL);
  wifiPrefs.end();
  strncpy(gHubBaseUrl, hub.c_str(), sizeof(gHubBaseUrl) - 1);
  gHubBaseUrl[sizeof(gHubBaseUrl) - 1] = '\0';
}

static bool saveHubSettings(const String &hubUrl) {
  String normalized = hubUrl;
  while (normalized.endsWith("/")) {
    normalized.remove(normalized.length() - 1);
  }
  if ((normalized.length() == 0) || (normalized.length() >= sizeof(gHubBaseUrl))) {
    return false;
  }
  if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
    return false;
  }
  wifiPrefs.begin("wifi", false);
  wifiPrefs.putString("hub_url", normalized);
  wifiPrefs.end();
  strncpy(gHubBaseUrl, normalized.c_str(), sizeof(gHubBaseUrl) - 1);
  gHubBaseUrl[sizeof(gHubBaseUrl) - 1] = '\0';
  return true;
}

static bool applyRecoveryResponse(const JsonDocument &responseDoc);

static void clearRecoveryHandshakeResultLocked() {
  gRecoveryTransportOk = false;
  gRecoveryStatusCode = 0;
  gRecoveryResponseBody[0] = '\0';
  gRecoveryError[0] = '\0';
}

static void resetRecoveryHandshakeAsyncState() {
  portENTER_CRITICAL(&gRecoveryMux);
  if (gRecoveryRequestInFlight) {
    // Let the active worker finish and publish its result to avoid races.
    portEXIT_CRITICAL(&gRecoveryMux);
    return;
  }
  gRecoveryResponseReady = false;
  gRecoveryEndpoint[0] = '\0';
  gRecoveryRequestBody[0] = '\0';
  clearRecoveryHandshakeResultLocked();
  portEXIT_CRITICAL(&gRecoveryMux);
}

static void setRecoveryHandshakeResult(bool transportOk, int statusCode, const char *errorText, const char *responseText) {
  portENTER_CRITICAL(&gRecoveryMux);
  gRecoveryTransportOk = transportOk;
  gRecoveryStatusCode = statusCode;
  if (errorText != nullptr) {
    strncpy(gRecoveryError, errorText, sizeof(gRecoveryError) - 1);
    gRecoveryError[sizeof(gRecoveryError) - 1] = '\0';
  } else {
    gRecoveryError[0] = '\0';
  }
  if (responseText != nullptr) {
    strncpy(gRecoveryResponseBody, responseText, sizeof(gRecoveryResponseBody) - 1);
    gRecoveryResponseBody[sizeof(gRecoveryResponseBody) - 1] = '\0';
  } else {
    gRecoveryResponseBody[0] = '\0';
  }
  gRecoveryResponseReady = true;
  gRecoveryRequestInFlight = false;
  portEXIT_CRITICAL(&gRecoveryMux);
}

static void resetRecoveryRuntimeState() {
  gRecoveryCheckDone = false;
  gRecoveryAttemptCount = 0;
  gNextRecoveryAttemptMs = 0;
  resetRecoveryHandshakeAsyncState();
}

static void recoveryHandshakeTask(void *unused) {
  (void)unused;
  char endpoint[RECOVERY_ENDPOINT_MAX_LEN];
  char requestBody[RECOVERY_REQUEST_MAX_LEN];

  portENTER_CRITICAL(&gRecoveryMux);
  strncpy(endpoint, gRecoveryEndpoint, sizeof(endpoint) - 1);
  endpoint[sizeof(endpoint) - 1] = '\0';
  strncpy(requestBody, gRecoveryRequestBody, sizeof(requestBody) - 1);
  requestBody[sizeof(requestBody) - 1] = '\0';
  portEXIT_CRITICAL(&gRecoveryMux);

  HTTPClient http;
  if (!http.begin(endpoint)) {
    setRecoveryHandshakeResult(false, 0, "failed to begin HTTP request", nullptr);
    vTaskDelete(nullptr);
    return;
  }
  http.setConnectTimeout(2000);
  http.setTimeout(2500);
  http.addHeader("Content-Type", "application/json");

  const int statusCode = http.POST(requestBody);
  if (statusCode != 200) {
    char errorText[RECOVERY_ERROR_MAX_LEN];
    snprintf(errorText, sizeof(errorText), "hub HTTP status %d", statusCode);
    http.end();
    setRecoveryHandshakeResult(false, statusCode, errorText, nullptr);
    vTaskDelete(nullptr);
    return;
  }

  const String responseBody = http.getString();
  http.end();
  setRecoveryHandshakeResult(true, statusCode, nullptr, responseBody.c_str());
  vTaskDelete(nullptr);
}

static bool startRecoveryHandshakeRequest() {
  JsonDocument requestDoc;
  requestDoc["boardIp"] = WiFi.localIP().toString();
  requestDoc["bootId"] = firmwareBootId();
  requestDoc["resetReason"] = firmwareResetReason();
  requestDoc["uptimeMs"] = millis();
  requestDoc["chemistry"] = batteryChemistryProfile().id;

  String requestBody;
  serializeJson(requestDoc, requestBody);
  if (requestBody.length() >= sizeof(gRecoveryRequestBody)) {
    Serial.println(F("Recovery: request body too large."));
    return false;
  }

  String endpoint = String(gHubBaseUrl) + "/api/boards/recovery-query";
  if (endpoint.length() >= sizeof(gRecoveryEndpoint)) {
    Serial.println(F("Recovery: endpoint URL too long."));
    return false;
  }

  portENTER_CRITICAL(&gRecoveryMux);
  strncpy(gRecoveryEndpoint, endpoint.c_str(), sizeof(gRecoveryEndpoint) - 1);
  gRecoveryEndpoint[sizeof(gRecoveryEndpoint) - 1] = '\0';
  strncpy(gRecoveryRequestBody, requestBody.c_str(), sizeof(gRecoveryRequestBody) - 1);
  gRecoveryRequestBody[sizeof(gRecoveryRequestBody) - 1] = '\0';
  gRecoveryResponseReady = false;
  clearRecoveryHandshakeResultLocked();
  gRecoveryRequestInFlight = true;
  portEXIT_CRITICAL(&gRecoveryMux);

  if (xTaskCreate(recoveryHandshakeTask, "recovery_http", 6144, nullptr, 1, nullptr) != pdPASS) {
    setRecoveryHandshakeResult(false, 0, "failed to start recovery task", nullptr);
    Serial.println(F("Recovery: failed to start HTTP worker task."));
    return false;
  }
  return true;
}

static void processRecoveryHandshakeResult() {
  bool responseReady = false;
  bool transportOk = false;
  int statusCode = 0;
  char errorText[RECOVERY_ERROR_MAX_LEN];
  char responseBody[RECOVERY_RESPONSE_MAX_LEN];

  portENTER_CRITICAL(&gRecoveryMux);
  responseReady = gRecoveryResponseReady;
  if (responseReady) {
    transportOk = gRecoveryTransportOk;
    statusCode = gRecoveryStatusCode;
    strncpy(errorText, gRecoveryError, sizeof(errorText) - 1);
    errorText[sizeof(errorText) - 1] = '\0';
    strncpy(responseBody, gRecoveryResponseBody, sizeof(responseBody) - 1);
    responseBody[sizeof(responseBody) - 1] = '\0';
    gRecoveryResponseReady = false;
    clearRecoveryHandshakeResultLocked();
  }
  portEXIT_CRITICAL(&gRecoveryMux);

  if (!responseReady) {
    return;
  }

  if (!transportOk) {
    if (errorText[0] != '\0') {
      Serial.printf("Recovery: %s\n", errorText);
    } else {
      Serial.printf("Recovery: transport failure (status=%d)\n", statusCode);
    }
    return;
  }

  JsonDocument responseDoc;
  const DeserializationError jsonErr = deserializeJson(responseDoc, responseBody);
  if (jsonErr) {
    Serial.printf("Recovery: invalid JSON from hub (%s)\n", jsonErr.c_str());
    return;
  }
  if (!(responseDoc["ok"] | false)) {
    const char *error = responseDoc["error"] | "unknown";
    Serial.printf("Recovery: hub error: %s\n", error);
    return;
  }

  applyRecoveryResponse(responseDoc);
  gRecoveryCheckDone = true;
}

static bool applyRecoveryResponse(const JsonDocument &responseDoc) {
  const bool recover = responseDoc["recover"] | false;
  if (!recover) {
    const char *reason = responseDoc["reason"] | "no-recovery";
    Serial.printf("Recovery: no restore (%s)\n", reason);
    return true;
  }

  JsonArrayConst channels = responseDoc["channels"].as<JsonArrayConst>();
  bool anyApplied = false;
  for (JsonObjectConst channel : channels) {
    const bool shouldRestore = channel["restore"] | false;
    if (!shouldRestore) {
      continue;
    }
    const uint8_t channelNumber = channel["channel"] | 0;
    const char *state = channel["state"] | "";
    const uint32_t elapsedMs = channel["stateElapsedMs"] | 0;
    const float capacityMah = channel["capacityMah"] | 0.0f;
    const uint16_t restingVoltageMv = channel["restingVoltageMv"] | 0;
    const uint16_t activeVoltageMv = channel["activeVoltageMv"] | 0;
    const uint32_t cellId = channel["cellId"] | 0;
    const uint8_t dischargeDuty = channel["dischargeDuty"] | 0;
    if (!restoreAutomationFromServer(channelNumber,
                                     state,
                                     elapsedMs,
                                     capacityMah,
                                     restingVoltageMv,
                                     activeVoltageMv,
                                     cellId,
                                     dischargeDuty)) {
      Serial.printf("Recovery: failed for CH%u\n", channelNumber);
      continue;
    }
    anyApplied = true;
  }

  Serial.printf("Recovery: restore request processed, applied=%s\n", anyApplied ? "yes" : "no");
  return true;
}

static void tryRecoveryHandshake() {
  processRecoveryHandshakeResult();

  if (gRecoveryCheckDone) {
    return;
  }
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }
  if (gRecoveryRequestInFlight) {
    return;
  }
  if (millis() < gNextRecoveryAttemptMs) {
    return;
  }
  if (gHubBaseUrl[0] == '\0') {
    Serial.println(F("Recovery: no hub URL configured (set via 'wifi hub <url>')."));
    gRecoveryCheckDone = true;
    return;
  }
  if (gRecoveryAttemptCount >= RECOVERY_MAX_ATTEMPTS) {
    Serial.println(F("Recovery: hub handshake max retries reached; skipping."));
    gRecoveryCheckDone = true;
    return;
  }

  gRecoveryAttemptCount++;
  gNextRecoveryAttemptMs = millis() + RECOVERY_RETRY_INTERVAL_MS;
  (void)startRecoveryHandshakeRequest();
}

static void handleApiCharge(uint8_t channel) {
  if (!server.hasArg("plain")) {
    sendJson(400, F("{\"ok\":false,\"error\":\"missing JSON body\"}"));
    return;
  }
  const String body = server.arg("plain");
  const bool enabled = body.indexOf(F("\"enabled\":true")) >= 0;
  if (trySetBQChargeEnable(channel, enabled)) {
    sendJson(200, F("{\"ok\":true}"));
  } else {
    String json = F("{\"ok\":false,\"error\":\"");
    json += gLastActionError;
    json += F("\"}");
    sendJson(409, json);
  }
}

static void handleApiDischarge(uint8_t channel) {
  if (!server.hasArg("plain")) {
    sendJson(400, F("{\"ok\":false,\"error\":\"missing JSON body\"}"));
    return;
  }
  const String body = server.arg("plain");
  const int dutyKey = body.indexOf(F("\"duty\""));
  if (dutyKey < 0) {
    sendJson(400, F("{\"ok\":false,\"error\":\"missing duty field\"}"));
    return;
  }
  const int colon = body.indexOf(':', dutyKey);
  const int end = body.indexOf(',', colon);
  const String dutyToken = body.substring(colon + 1, (end < 0) ? body.length() : end);
  const uint32_t duty = static_cast<uint32_t>(dutyToken.toInt());
  if (duty > 255) {
    sendJson(400, F("{\"ok\":false,\"error\":\"duty must be 0-255\"}"));
    return;
  }
  if (trySetPWMChannel(channel, static_cast<uint8_t>(duty))) {
    sendJson(200, F("{\"ok\":true}"));
  } else {
    String json = F("{\"ok\":false,\"error\":\"");
    json += gLastActionError;
    json += F("\"}");
    sendJson(409, json);
  }
}

static void handleApiIchg(uint8_t channel) {
  if (!server.hasArg("plain")) {
    sendJson(400, F("{\"ok\":false,\"error\":\"missing JSON body\"}"));
    return;
  }
  const String body = server.arg("plain");
  const int maKey = body.indexOf(F("\"milliamps\""));
  if (maKey < 0) {
    sendJson(400, F("{\"ok\":false,\"error\":\"missing milliamps field\"}"));
    return;
  }
  const int colon = body.indexOf(':', maKey);
  const int end = body.indexOf(',', colon);
  const String maToken = body.substring(colon + 1, (end < 0) ? body.length() : end);
  const uint32_t milliamps = static_cast<uint32_t>(maToken.toInt());
  gLastActionError[0] = '\0';
  if (setBQChargeCurrentLimit(channel, static_cast<uint16_t>(milliamps))) {
    sendJson(200, F("{\"ok\":true}"));
  } else {
    String json = F("{\"ok\":false,\"error\":\"");
    json += (gLastActionError[0] != '\0') ? gLastActionError : "failed to set charge current";
    json += F("\"}");
    sendJson(409, json);
  }
}

static void handleApiAutoStart(uint8_t channel) {
  if (!server.hasArg("plain")) {
    sendJson(400, F("{\"ok\":false,\"error\":\"missing JSON body\"}"));
    return;
  }
  const String body = server.arg("plain");
  const int idKey = body.indexOf(F("\"cellId\""));
  if (idKey < 0) {
    sendJson(400, F("{\"ok\":false,\"error\":\"missing cellId field\"}"));
    return;
  }
  const int colon = body.indexOf(':', idKey);
  const int end = body.indexOf(',', colon);
  const int endBrace = body.indexOf('}', colon);
  const int actualEnd = (end < 0 || (endBrace >= 0 && endBrace < end)) ? endBrace : end;
  
  const String idToken = body.substring(colon + 1, (actualEnd < 0) ? body.length() : actualEnd);
  const uint32_t cellId = static_cast<uint32_t>(idToken.toInt());
  
  startAutomation(channel, cellId);
  sendJson(200, F("{\"ok\":true}"));
}

static void handleApiAutoStop(uint8_t channel) {
  stopAutomation(channel);
  sendJson(200, F("{\"ok\":true}"));
}

static void handleApiChemistry() {
  if (!server.hasArg("plain")) {
    sendJson(400, F("{\"ok\":false,\"error\":\"missing JSON body\"}"));
    return;
  }

  JsonDocument request;
  const DeserializationError parseError = deserializeJson(request, server.arg("plain"));
  if (parseError) {
    sendJson(400, F("{\"ok\":false,\"error\":\"invalid JSON body\"}"));
    return;
  }
  const char *id = request["chemistry"];
  if (id == nullptr) {
    sendJson(400, F("{\"ok\":false,\"error\":\"missing chemistry field\"}"));
    return;
  }

  CellChemistry chemistry;
  if (strcmp(id, "lifepo4") == 0) {
    chemistry = CellChemistry::LIFEPO4;
  } else if (strcmp(id, "nmc_18650") == 0) {
    chemistry = CellChemistry::NMC_18650;
  } else {
    sendJson(400, F("{\"ok\":false,\"error\":\"chemistry must be lifepo4 or nmc_18650\"}"));
    return;
  }

  if (!changeBatteryChemistry(chemistry)) {
    String response = F("{\"ok\":false,\"error\":\"");
    response += (gLastActionError[0] != '\0') ? gLastActionError : "failed to change chemistry";
    response += F("\"}");
    sendJson(409, response);
    return;
  }

  const CellChemistryProfile &profile = batteryChemistryProfile();
  String response = F("{\"ok\":true,\"chemistry\":{\"id\":\"");
  response += profile.id;
  response += F("\",\"label\":\"");
  response += profile.label;
  response += F("\",\"maxChargeVoltageMv\":");
  response += profile.maxChargeVoltageMv;
  response += F(",\"dischargeCutoffMv\":");
  response += profile.dischargeCutoffMv;
  response += F(",\"chargeCurrentMa\":");
  response += profile.chargeCurrentMa;
  response += F("}}");
  sendJson(200, response);
}

static void startHttpServerIfNeeded() {
  if (httpServerStarted) {
    return;
  }

  server.on("/api/status", HTTP_GET, []() {
    if (!gStatusJsonReady || (gStatusJson[0] == '\0')) {
      sendJsonBuffer(503, "{\"ok\":false,\"error\":\"status not ready\"}");
      return;
    }
    sendJsonBuffer(200, gStatusJson);
  });

  server.on("/api/status", HTTP_OPTIONS, sendOptions);
  server.on("/api/channel/1/charge", HTTP_OPTIONS, sendOptions);
  server.on("/api/channel/2/charge", HTTP_OPTIONS, sendOptions);
  server.on("/api/channel/1/discharge", HTTP_OPTIONS, sendOptions);
  server.on("/api/channel/2/discharge", HTTP_OPTIONS, sendOptions);
  server.on("/api/channel/1/ichg", HTTP_OPTIONS, sendOptions);
  server.on("/api/channel/2/ichg", HTTP_OPTIONS, sendOptions);
  server.on("/api/channel/1/auto/start", HTTP_OPTIONS, sendOptions);
  server.on("/api/channel/2/auto/start", HTTP_OPTIONS, sendOptions);
  server.on("/api/channel/1/auto/stop", HTTP_OPTIONS, sendOptions);
  server.on("/api/channel/2/auto/stop", HTTP_OPTIONS, sendOptions);
  server.on("/api/chemistry", HTTP_OPTIONS, sendOptions);
  server.on("/api/alloff", HTTP_OPTIONS, sendOptions);

  server.on("/api/channel/1/charge", HTTP_POST, []() { handleApiCharge(1); });
  server.on("/api/channel/2/charge", HTTP_POST, []() { handleApiCharge(2); });
  server.on("/api/channel/1/discharge", HTTP_POST, []() { handleApiDischarge(1); });
  server.on("/api/channel/2/discharge", HTTP_POST, []() { handleApiDischarge(2); });
  server.on("/api/channel/1/ichg", HTTP_POST, []() { handleApiIchg(1); });
  server.on("/api/channel/2/ichg", HTTP_POST, []() { handleApiIchg(2); });
  server.on("/api/channel/1/auto/start", HTTP_POST, []() { handleApiAutoStart(1); });
  server.on("/api/channel/2/auto/start", HTTP_POST, []() { handleApiAutoStart(2); });
  server.on("/api/channel/1/auto/stop", HTTP_POST, []() { handleApiAutoStop(1); });
  server.on("/api/channel/2/auto/stop", HTTP_POST, []() { handleApiAutoStop(2); });
  server.on("/api/chemistry", HTTP_POST, handleApiChemistry);

  server.on("/api/alloff", HTTP_POST, []() {
    setAllOutputsOff();
    stopAutomation(1);
    stopAutomation(2);
    makeBQSafe(1);
    makeBQSafe(2);
    sendJson(200, F("{\"ok\":true}"));
  });

  server.onNotFound([]() {
    sendJson(404, F("{\"ok\":false,\"error\":\"not found\"}"));
  });

  server.begin();
  httpServerStarted = true;
  gHttpStartMs = millis();
  strncpy(gStatusJson, "{\"ok\":true,\"status\":\"warming up\"}", sizeof(gStatusJson) - 1);
  gStatusJson[sizeof(gStatusJson) - 1] = '\0';
  gStatusJsonReady = true;
  WiFi.setSleep(false);
  Serial.println(F("HTTP API started on port 80"));
}

static void connectWifiFromSavedCredentials() {
  if (savedSsid.length() == 0) {
    Serial.println(F("WiFi: no saved credentials. Use: wifi set <ssid> <password>"));
    gWifiConnectionFault = true;
    gWifiConnectStartedMs = 0;
    return;
  }

  Serial.printf("WiFi: connecting to \"%s\"...\n", savedSsid.c_str());
  WiFi.mode(WIFI_STA);
  WiFi.setTxPower(WIFI_TX_POWER_LIMIT);
  WiFi.setAutoReconnect(true);
  WiFi.begin(savedSsid.c_str(), savedPassword.c_str());
  gWifiConnectStartedMs = millis();
  gNextWifiReconnectMs = gWifiConnectStartedMs + WIFI_CONNECT_TIMEOUT_MS;
  gWifiConnectionFault = false;
}

void wifiApiInit() {
  loadWifiCredentials();
  loadHubSettings();
  resetRecoveryRuntimeState();
  connectWifiFromSavedCredentials();
}

void wifiGetSnapshotInfo(bool &connected, char *ssid, size_t ssidLen, char *ip, size_t ipLen, char *statusText,
                         size_t statusLen) {
  connected = (WiFi.status() == WL_CONNECTED);
  strncpy(ssid, savedSsid.c_str(), ssidLen - 1);
  ssid[ssidLen - 1] = '\0';
  if (connected) {
    const IPAddress addr = WiFi.localIP();
    snprintf(ip, ipLen, "%u.%u.%u.%u", addr[0], addr[1], addr[2], addr[3]);
  } else {
    ip[0] = '\0';
  }
  ip[ipLen - 1] = '\0';

  const char *status = "unknown";
  switch (WiFi.status()) {
    case WL_CONNECTED:
      status = "connected";
      break;
    case WL_IDLE_STATUS:
      status = "idle";
      break;
    case WL_NO_SSID_AVAIL:
      status = "no_ssid";
      break;
    case WL_CONNECT_FAILED:
      status = "connect_failed";
      break;
    case WL_CONNECTION_LOST:
      status = "connection_lost";
      break;
    case WL_DISCONNECTED:
      status = "disconnected";
      break;
    default:
      break;
  }
  strncpy(statusText, status, statusLen - 1);
  statusText[statusLen - 1] = '\0';
}

bool wifiApiReady() {
  return httpServerStarted && WiFi.status() == WL_CONNECTED;
}

bool wifiApiHasFault() {
  return gWifiConnectionFault;
}

void wifiApiLoop() {
  const uint32_t now = millis();
  const wl_status_t wifiStatus = WiFi.status();
  if (wifiStatus == WL_CONNECTED) {
    gWifiConnectionFault = false;
    gWifiConnectStartedMs = 0;
  } else if (savedSsid.length() == 0) {
    gWifiConnectionFault = true;
  } else if (gWifiConnectStartedMs == 0) {
    connectWifiFromSavedCredentials();
  } else if ((now - gWifiConnectStartedMs) >= WIFI_CONNECT_TIMEOUT_MS) {
    gWifiConnectionFault = true;
    if (static_cast<int32_t>(now - gNextWifiReconnectMs) >= 0) {
      Serial.println(F("WiFi: connection timed out; retrying."));
      WiFi.disconnect(false, false);
      WiFi.begin(savedSsid.c_str(), savedPassword.c_str());
      gWifiConnectStartedMs = now;
      gNextWifiReconnectMs = now + WIFI_RECONNECT_INTERVAL_MS;
    }
  }

  if ((!httpServerStarted) && (WiFi.status() == WL_CONNECTED)) {
    Serial.print(F("WiFi connected. IP: "));
    Serial.println(WiFi.localIP());
    startHttpServerIfNeeded();
  }

  tryRecoveryHandshake();

  if (httpServerStarted) {
    static uint32_t wifiLoopCount = 0;
    if (wifiLoopCount < 20) {
      DBG_CHK_PRINTF("[CHK] wifiApiLoop %u: before handleClient\n", wifiLoopCount);
    }
    server.handleClient();
    if (wifiLoopCount < 20) {
      DBG_CHK_PRINTF("[CHK] wifiApiLoop %u: before tickStatusJsonUpdate\n", wifiLoopCount);
    }
    tickStatusJsonUpdate();
    if (wifiLoopCount < 20) {
      DBG_CHK_PRINTF("[CHK] wifiApiLoop %u: end\n", wifiLoopCount);
      wifiLoopCount++;
    }
  }
}

static String commandTokenLocal(const String &command, uint8_t requestedIndex) {
  uint8_t currentIndex = 0;
  int position = 0;
  while (position < command.length()) {
    while ((position < command.length()) && isspace(command[position])) {
      position++;
    }
    if (position >= command.length()) {
      break;
    }
    const int start = position;
    while ((position < command.length()) && !isspace(command[position])) {
      position++;
    }
    if (currentIndex == requestedIndex) {
      return command.substring(start, position);
    }
    currentIndex++;
  }
  return String();
}

static String commandRemainderAfterTokensLocal(const String &command, uint8_t tokenCount) {
  uint8_t currentIndex = 0;
  int position = 0;
  while (position < command.length()) {
    while ((position < command.length()) && isspace(command[position])) {
      position++;
    }
    if (position >= command.length()) {
      return String();
    }
    while ((position < command.length()) && !isspace(command[position])) {
      position++;
    }
    currentIndex++;
    if (currentIndex >= tokenCount) {
      while ((position < command.length()) && isspace(command[position])) {
        position++;
      }
      return command.substring(position);
    }
  }
  return String();
}

void printWifiHelpLine() {
  Serial.println(F("  wifi status | wifi set <ssid> <password> | wifi clear | wifi connect | wifi hub <http://hub:3001>"));
}

void handleWifiSerialCommand(const String &command) {
  String lower = command;
  lower.toLowerCase();
  const String action = commandTokenLocal(lower, 1);

  if (lower == F("wifi status")) {
    Serial.println(F("WiFi status:"));
    Serial.printf("  Saved SSID: %s\n", savedSsid.length() ? savedSsid.c_str() : "(none)");
    Serial.printf("  Hub URL: %s\n", (gHubBaseUrl[0] != '\0') ? gHubBaseUrl : "(not set)");
    Serial.printf("  Link: %s\n", (WiFi.status() == WL_CONNECTED) ? "connected" : "disconnected");
    if (WiFi.status() == WL_CONNECTED) {
      Serial.printf("  IP: %s\n", WiFi.localIP().toString().c_str());
      Serial.printf("  RSSI: %d dBm\n", WiFi.RSSI());
    }
    Serial.printf("  HTTP API: %s\n", httpServerStarted ? "running on :80" : "not started");
    Serial.printf("  Recovery handshake: %s (%u/%u attempts)\n",
                  gRecoveryCheckDone ? "done" : "pending",
                  static_cast<unsigned>(gRecoveryAttemptCount),
                  static_cast<unsigned>(RECOVERY_MAX_ATTEMPTS));
    return;
  }

  if (action == F("set")) {
    const String ssid = commandTokenLocal(command, 2);
    const String password = commandRemainderAfterTokensLocal(command, 3);
    if ((ssid.length() == 0) || (password.length() == 0)) {
      Serial.println(F("Usage: wifi set <ssid> <password>"));
      return;
    }
    if (!saveWifiCredentials(ssid, password)) {
      Serial.println(F("WiFi credentials not saved (invalid length)."));
      return;
    }
    Serial.println(F("WiFi credentials saved to NVS."));
    resetRecoveryRuntimeState();
    connectWifiFromSavedCredentials();
    return;
  }

  if (action == F("clear")) {
    clearWifiCredentials();
    WiFi.disconnect(true);
    httpServerStarted = false;
    resetRecoveryRuntimeState();
    Serial.println(F("WiFi credentials cleared."));
    return;
  }

  if (action == F("hub")) {
    const String hubUrl = commandRemainderAfterTokensLocal(command, 2);
    if (hubUrl.length() == 0) {
      Serial.printf("Current hub URL: %s\n", (gHubBaseUrl[0] != '\0') ? gHubBaseUrl : "(not set)");
      return;
    }
    if (!saveHubSettings(hubUrl)) {
      Serial.println(F("Invalid hub URL. Use: wifi hub http://<host>:3001"));
      return;
    }
    resetRecoveryRuntimeState();
    Serial.printf("Hub URL saved: %s\n", gHubBaseUrl);
    return;
  }

  if (action == F("connect")) {
    resetRecoveryRuntimeState();
    connectWifiFromSavedCredentials();
    return;
  }

  Serial.println(F("Unknown wifi command. Use: wifi status | set | clear | connect | hub"));
}
