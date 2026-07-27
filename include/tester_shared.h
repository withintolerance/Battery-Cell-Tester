#pragma once

#include <Arduino.h>
#include <stdint.h>

#ifndef ENABLE_SERIAL_OUTPUT
#define ENABLE_SERIAL_OUTPUT 1
#endif

#ifndef ENABLE_DEBUG_SERIAL_CHECKPOINTS
#define ENABLE_DEBUG_SERIAL_CHECKPOINTS 0
#endif

#if ENABLE_DEBUG_SERIAL_CHECKPOINTS && ENABLE_SERIAL_OUTPUT
#define DBG_CHK_PRINTF(...)      \
  do {                           \
    Serial.printf(__VA_ARGS__);  \
    Serial.flush();              \
  } while (0)
#define DBG_CHK_PRINTLN(message) \
  do {                           \
    Serial.println(message);     \
    Serial.flush();              \
  } while (0)
#else
#define DBG_CHK_PRINTF(...) do { } while (0)
#define DBG_CHK_PRINTLN(message) do { } while (0)
#endif

#if !ENABLE_SERIAL_OUTPUT
class NullSerialSink {
public:
  void begin(unsigned long baud);
  void begin(unsigned long baud, uint32_t config);
  void end();
  int available();
  int read();
  void flush();
  size_t write(uint8_t value);
  size_t write(const uint8_t *buffer, size_t size);
  size_t write(const char *str);

  template <typename T>
  size_t print(const T &) {
    return 0;
  }

  template <typename T>
  size_t println(const T &) {
    return 0;
  }

  size_t println() {
    return 0;
  }

  template <typename... Args>
  size_t printf(const char *, Args...) {
    return 0;
  }

  explicit operator bool() const {
    return true;
  }
};

extern NullSerialSink gNullSerial;
#endif

static constexpr uint16_t CELL_PRESENT_MIN_MV = 2500;
static constexpr uint16_t BQ25622_ICHG_MIN_MA = 80;
static constexpr uint16_t BQ25622_ICHG_MAX_MA = 3000;
static constexpr uint16_t BQ25622_ICHG_STEP_MA = 80;

enum class CellChemistry : uint8_t {
  LIFEPO4 = 0,
  NMC_18650 = 1,
};

struct CellChemistryProfile {
  CellChemistry chemistry;
  const char *id;
  const char *label;
  uint16_t maxChargeVoltageMv;
  uint16_t dischargeCutoffMv;
  uint16_t chargeCurrentMa;
  uint16_t storageChargeCurrentMa;
  uint16_t prechargeCurrentMa;
  uint16_t minimumSystemVoltageMv;
};

struct ThermistorReading {
  uint8_t adsChannel;
  const char *label;
  bool valid;
  int16_t counts;
  float volts;
  float resistanceOhms;
  float temperatureC;
};

struct InaReading {
  uint8_t address;
  const char *label;
  bool valid;
  float busVolts;
  float shuntMilliVolts;
  float currentAmps;
  float powerWatts;
};

struct BqChannelReading {
  uint8_t channel;
  const char *label;
  bool valid;
  uint16_t cellVoltageMv;
  bool cellPresent;
  bool chargeEnabled;
  uint8_t dischargeDuty;
  uint16_t ichgLimitMa;
  uint8_t control1;
  uint8_t status1;
  uint8_t fault0;
  const char *chgStatusText;
  const char *vbusStatusText;
  int16_t ibusMa;
  int16_t ibatMa;
  uint16_t vbusMv;
  uint16_t vpmidMv;
  uint16_t vbatMv;
  uint16_t vsysMv;
  int16_t tdieApproxC;
};

enum class AutoState {
  IDLE = 0,
  CHARGE_INITIAL,
  REST,
  DISCHARGE,
  CHARGE_STORAGE,
  COMPLETE,
  FAULT
};

struct AutomationChannelState {
  AutoState state;
  uint32_t stateStartMs;
  uint32_t lastTickMs;
  float capacityMah;
  uint16_t restingVoltageMv;
  uint16_t activeVoltageMv; // INA Kelvin voltage measured 5 minutes into discharge
  char faultReason[32];
  uint32_t cellId;
};

struct SystemSnapshot {
  bool fanOn;
  bool rs485TransmitMode;
  uint32_t bootId;
  uint32_t uptimeMs;
  char resetReason[24];
  int i2c1DeviceCount;
  int i2c2DeviceCount;
  bool wifiConnected;
  char wifiSsid[33];
  char wifiIp[16];
  char wifiStatus[24];
  BqChannelReading channel1;
  BqChannelReading channel2;
  InaReading ina1;
  InaReading ina2;
  ThermistorReading thermCellA;
  ThermistorReading thermCellB;
  ThermistorReading thermHeatsink;
  ThermistorReading thermNc;
  AutomationChannelState auto1;
  AutomationChannelState auto2;
};

extern char gLastActionError[160];

bool readChannelCellVoltageMv(uint8_t channelNumber, uint16_t &voltageMv);
bool bqReadChargeCurrentLimitMa(uint8_t chargerNumber, uint16_t &currentMa);
bool setBQChargeCurrentLimit(uint8_t chargerNumber, uint16_t requestedMa);
bool trySetBQChargeEnable(uint8_t channelNumber, bool enabled);
bool trySetPWMChannel(uint8_t channelNumber, uint8_t duty);
void setAllOutputsOff();
void makeBQSafe(uint8_t chargerNumber);
void collectSystemSnapshot(SystemSnapshot &snapshot);
void resetSnapshotCollection();
bool snapshotCollectionIdle();
bool tickSnapshotCollection(SystemSnapshot &snapshot);
void wifiApiInit();
void wifiApiLoop();
void wifiGetSnapshotInfo(bool &connected, char *ssid, size_t ssidLen, char *ip, size_t ipLen, char *statusText,
                         size_t statusLen);
void handleWifiSerialCommand(const String &command);
void printWifiHelpLine();

// Boot/API debug: prints label, free heap, then waits 300 ms.
void debugCheckpoint(const char *label);

void startAutomation(uint8_t channel, uint32_t cellId);
void stopAutomation(uint8_t channel);
void tickAutomation(SystemSnapshot &snapshot);
bool automationHasActiveChannel();
bool automationHasCompleteChannel();
bool automationHasFault();
bool restoreAutomationFromServer(uint8_t channel,
                                 const char *stateName,
                                 uint32_t stateElapsedMs,
                                 float capacityMah,
                                 uint16_t restingVoltageMv,
                                 uint16_t activeVoltageMv,
                                 uint32_t cellId,
                                 uint8_t dischargeDuty);
void setFanManualOverride(bool override);
bool automationIsIdle();

bool wifiApiReady();
bool wifiApiHasFault();

void initializeBatteryChemistry();
const CellChemistryProfile &batteryChemistryProfile();
bool changeBatteryChemistry(CellChemistry chemistry);

uint32_t firmwareBootId();
const char *firmwareResetReason();
