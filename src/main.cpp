#include <Arduino.h>
#include <Adafruit_NeoPixel.h>
#include <Preferences.h>
#include <Wire.h>
#include <esp_system.h>
#include <math.h>
#include <cstring>

#include "tester_shared.h"

#if __has_include(<esp_arduino_version.h>)
#include <esp_arduino_version.h>
#endif

#if !ENABLE_SERIAL_OUTPUT
#define Serial gNullSerial
#endif

static const char *resetReasonLabel() {
  switch (esp_reset_reason()) {
    case ESP_RST_UNKNOWN: return "UNKNOWN";
    case ESP_RST_POWERON: return "POWERON";
    case ESP_RST_EXT: return "EXT";
    case ESP_RST_SW: return "SW";
    case ESP_RST_PANIC: return "PANIC";
    case ESP_RST_INT_WDT: return "INT_WDT";
    case ESP_RST_TASK_WDT: return "TASK_WDT";
    case ESP_RST_WDT: return "WDT";
    case ESP_RST_DEEPSLEEP: return "DEEPSLEEP";
    case ESP_RST_BROWNOUT: return "BROWNOUT";
    case ESP_RST_SDIO: return "SDIO";
    default: return "?";
  }
}

static uint32_t gBootSessionId = 0;
static char gBootResetReason[24] = "unknown";
static bool gBootInitializationComplete = false;
static bool gBootInitializationFault = false;

// Pin map for the custom ESP32-S2 Mini-2 battery cell charger/discharger tester PCB.
static constexpr uint8_t PIN_BOOT_BUTTON = 0;
static constexpr uint8_t PIN_WS2812 = 4;
static constexpr uint8_t PIN_FAN_MOSFET = 5;
static constexpr uint8_t PIN_BQ2_CE = 6;
static constexpr uint8_t PIN_BQ2_INT = 7;
static constexpr uint8_t PIN_I2C1_SDA = 8;
static constexpr uint8_t PIN_I2C1_SCL = 9;
static constexpr uint8_t PIN_I2C2_SDA = 11;
static constexpr uint8_t PIN_I2C2_SCL = 10;
static constexpr uint8_t PIN_DCHG_PWM_CH2 = 12;
static constexpr uint8_t PIN_DCHG_PWM_CH1 = 13;
static constexpr uint8_t PIN_BQ1_CE = 14;
static constexpr uint8_t PIN_BQ1_INT = 15;
static constexpr uint8_t PIN_RS485_TX = 26;    // SP3485 DI
static constexpr uint8_t PIN_RS485_RE_DE = 33; // LOW = receive, HIGH = transmit
static constexpr uint8_t PIN_RS485_RX = 34;    // SP3485 RO
static constexpr uint8_t PIN_DEBUG_TX = 43;
static constexpr uint8_t PIN_DEBUG_RX = 44;

static constexpr uint32_t SERIAL_BAUD = 115200;
static constexpr uint32_t I2C_CLOCK_HZ = 100000;
static constexpr uint32_t RS485_BAUD = 115200;
static constexpr uint32_t PWM_FREQUENCY_HZ = 1000;
static constexpr uint8_t PWM_RESOLUTION_BITS = 8;
static constexpr uint8_t PWM_CHANNEL_1 = 0;
static constexpr uint8_t PWM_CHANNEL_2 = 1;

// Bus 1 uses the framework Wire object (never TwoWire(0) — that shadows Wire).
// Bus 2 is bit-banged: the second hardware I2C driver's i2cInit() overflows the
// 8 KB Arduino loop stack in this full firmware build (see platformio.ini).
TwoWire &I2C1 = Wire;
static SemaphoreHandle_t gI2cMutex = nullptr;

static bool i2cLock() {
  return (gI2cMutex != nullptr) &&
         (xSemaphoreTakeRecursive(gI2cMutex, pdMS_TO_TICKS(100)) == pdTRUE);
}

static void i2cUnlock() {
  if (gI2cMutex != nullptr) {
    xSemaphoreGiveRecursive(gI2cMutex);
  }
}
HardwareSerial RS485Serial(1);
Adafruit_NeoPixel statusLed(1, PIN_WS2812, NEO_GRB + NEO_KHZ800);

uint8_t pwm1Duty = 0;
uint8_t pwm2Duty = 0;
bool fanOn = false;
bool bq1CeOn = false;
bool bq2CeOn = false;
bool rs485TransmitMode = false;
int lastI2C1DeviceCount = -1;
int lastI2C2DeviceCount = -1;

static constexpr uint8_t ADS1115_ADDR = 0x48;
static constexpr uint8_t INA226_ADDR_1 = 0x40;
static constexpr uint8_t INA226_ADDR_2 = 0x41;
static constexpr uint8_t BQ25622_ADDR = 0x6B;

static constexpr uint8_t ADS1115_REG_CONVERSION = 0x00;
static constexpr uint8_t ADS1115_REG_CONFIG = 0x01;

static constexpr uint8_t INA226_REG_CONFIG = 0x00;
static constexpr uint8_t INA226_REG_SHUNT_VOLTAGE = 0x01;
static constexpr uint8_t INA226_REG_BUS_VOLTAGE = 0x02;
static constexpr uint8_t INA226_REG_POWER = 0x03;
static constexpr uint8_t INA226_REG_CURRENT = 0x04;
static constexpr uint8_t INA226_REG_CALIBRATION = 0x05;
static constexpr uint8_t INA226_REG_MANUFACTURER_ID = 0xFE;
static constexpr uint8_t INA226_REG_DIE_ID = 0xFF;
static constexpr float INA226_SHUNT_OHMS = 0.020f;
static constexpr float INA226_CURRENT_LSB_A = 0.000125f; // 0.125 mA/LSB gives +/-4.096 A full scale with 20 mOhm.
static constexpr uint16_t INA226_CALIBRATION_VALUE = 2048; // 0.00512 / (0.000125 A * 0.020 ohm)

static constexpr uint8_t BQ25622_REG_CHARGE_CURRENT_LIMIT = 0x02;
static constexpr uint8_t BQ25622_REG_CHARGE_VOLTAGE_LIMIT = 0x04;
static constexpr uint8_t BQ25622_REG_INPUT_CURRENT_LIMIT = 0x06;
static constexpr uint8_t BQ25622_REG_MINIMAL_SYSTEM_VOLTAGE = 0x0E;
static constexpr uint8_t BQ25622_REG_PRECHARGE_CONTROL = 0x10;
static constexpr uint8_t BQ25622_REG_TERMINATION_CONTROL = 0x12;
static constexpr uint8_t BQ25622_REG_CHARGER_CONTROL_1 = 0x16;
static constexpr uint8_t BQ25622_REG_CHARGER_CONTROL_3 = 0x18;
static constexpr uint8_t BQ25622_REG_CHARGER_STATUS_1 = 0x1E;
static constexpr uint8_t BQ25622_REG_FAULT_STATUS_0 = 0x1F;
static constexpr uint8_t BQ25622_REG_ADC_CONTROL = 0x26;
static constexpr uint8_t BQ25622_REG_IBUS_ADC = 0x28;
static constexpr uint8_t BQ25622_REG_IBAT_ADC = 0x2A;
static constexpr uint8_t BQ25622_REG_VBUS_ADC = 0x2C;
static constexpr uint8_t BQ25622_REG_VPMID_ADC = 0x2E;
static constexpr uint8_t BQ25622_REG_VBAT_ADC = 0x30;
static constexpr uint8_t BQ25622_REG_VSYS_ADC = 0x32;
static constexpr uint8_t BQ25622_REG_TDIE_ADC = 0x36;
static constexpr uint8_t BQ25622_REG_PART_INFORMATION = 0x38;

static constexpr uint8_t BQ25622_CONTROL1_EN_CHG = 0x20;
static constexpr uint8_t BQ25622_CONTROL1_EN_HIZ = 0x10;
static constexpr uint8_t BQ25622_CONTROL1_WATCHDOG_MASK = 0x03;
static constexpr uint8_t BQ25622_ADC_CONTROL_EN = 0x80;
static constexpr uint8_t BQ25622_ADC_CONTROL_12BIT_CONTINUOUS = 0x00;
static constexpr uint8_t BQ25622_ADC_CONTROL_DEFAULT = 0x30;
static constexpr uint16_t BQ25622_IPRECHG_STEP_MA = 20;
static constexpr uint16_t BQ25622_PRECHARGE_MAX_MA = 620;
static constexpr uint8_t STATUS_LED_BRIGHTNESS = 128;
// Cell A, Cell B, and the heatsink now use the same 10k NTC divider.
static constexpr float THERMISTOR_SERIES_OHMS = 10000.0f;
static constexpr float THERMISTOR_NOMINAL_OHMS = 10000.0f;
static constexpr float THERMISTOR_BETA = 3450.0f;
static constexpr float THERMISTOR_NOMINAL_K = 298.15f;
static constexpr float ADS1115_THERMISTOR_SUPPLY_V = 3.3f;
static constexpr uint8_t BQ_CE_ACTIVE_LEVEL = LOW; // BQ25622 CE is active-low.

static constexpr CellChemistryProfile LIFEPO4_PROFILE = {
    CellChemistry::LIFEPO4,
    "lifepo4",
    "LiFePO4",
    3600,
    2500,
    2480,
    2480,
    620,
    2560,
};

// Conservative generic 18650 NMC profile. A specific cell datasheet may permit
// more current, but 4.20 V is always enforced as the charge-voltage ceiling.
static constexpr CellChemistryProfile NMC_18650_PROFILE = {
    CellChemistry::NMC_18650,
    "nmc_18650",
    "18650 Li-ion (NMC)",
    4200,
    2750,
    960,
    960,
    200,
    3520,
};

static CellChemistry gCellChemistry = CellChemistry::LIFEPO4;

bool readChannelCellVoltageMv(uint8_t channelNumber, uint16_t &voltageMv);

String resetReasonToString(esp_reset_reason_t reason) {
  switch (reason) {
    case ESP_RST_POWERON:
      return F("power-on");
    case ESP_RST_EXT:
      return F("external");
    case ESP_RST_SW:
      return F("software");
    case ESP_RST_PANIC:
      return F("panic");
    case ESP_RST_INT_WDT:
      return F("interrupt watchdog");
    case ESP_RST_TASK_WDT:
      return F("task watchdog");
    case ESP_RST_WDT:
      return F("other watchdog");
    case ESP_RST_DEEPSLEEP:
      return F("deep sleep");
    case ESP_RST_BROWNOUT:
      return F("brownout");
    case ESP_RST_SDIO:
      return F("SDIO");
    default:
      return F("unknown");
  }
}

uint32_t firmwareBootId() {
  return gBootSessionId;
}

const char *firmwareResetReason() {
  return gBootResetReason;
}

void writePwm(uint8_t pin, uint8_t channel, uint8_t duty) {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && (ESP_ARDUINO_VERSION_MAJOR >= 3)
  if (duty == 0) {
    ledcDetach(pin);
    pinMode(pin, OUTPUT);
    digitalWrite(pin, LOW);
  } else {
    ledcAttachChannel(pin, PWM_FREQUENCY_HZ, PWM_RESOLUTION_BITS, channel);
    ledcWrite(pin, duty);
  }
#else
  if (duty == 0) {
    ledcDetachPin(pin);
    pinMode(pin, OUTPUT);
    digitalWrite(pin, LOW);
  } else {
    ledcSetup(channel, PWM_FREQUENCY_HZ, PWM_RESOLUTION_BITS);
    ledcAttachPin(pin, channel);
    ledcWrite(channel, duty);
  }
#endif
}

void setupPwm(uint8_t pin, uint8_t channel) {
  pinMode(pin, OUTPUT);
  digitalWrite(pin, LOW);
}

void setLedColor(uint8_t red, uint8_t green, uint8_t blue) {
  static uint8_t lastRed = 0xFF;
  static uint8_t lastGreen = 0xFF;
  static uint8_t lastBlue = 0xFF;
  if ((red == lastRed) && (green == lastGreen) && (blue == lastBlue)) {
    return;
  }
  lastRed = red;
  lastGreen = green;
  lastBlue = blue;
  statusLed.setPixelColor(0, statusLed.Color(red, green, blue));
  statusLed.show();
}

static void tickStatusLed() {
  if (!gBootInitializationComplete) {
    setLedColor(0, 0, 0);
    return;
  }

  const bool blinkOn = (millis() % 1000UL) < 500UL;
  if (gBootInitializationFault || wifiApiHasFault() || automationHasFault()) {
    setLedColor(blinkOn ? 255 : 0, 0, 0);
  } else if (automationHasCompleteChannel()) {
    setLedColor(0, blinkOn ? 255 : 0, 0);
  } else if (automationHasActiveChannel()) {
    setLedColor(0, 0, blinkOn ? 255 : 0);
  } else if (wifiApiReady()) {
    setLedColor(0, 255, 0);
  } else {
    setLedColor(0, 0, 0);
  }
}

void setFan(bool on) {
  fanOn = on;
  // AO3400A is an N-channel MOSFET.
  // Gate HIGH = MOSFET ON (conducts to GND, turns fan ON)
  // Gate LOW = MOSFET OFF
  // Wait, if the fan is connected between 5V and the MOSFET Drain, and Source is GND,
  // then HIGH = ON, LOW = OFF.
  // BUT if the fan is connected between the MOSFET Source and GND, and Drain is 5V,
  // it would act as a source follower, which is bad design. Assuming standard low-side switch.
  digitalWrite(PIN_FAN_MOSFET, on ? HIGH : LOW);
  Serial.printf("Fan MOSFET: %s\n", on ? "ON" : "OFF");
}

void setBQCE(uint8_t pin, bool on, const char *name) {
  digitalWrite(pin, on ? BQ_CE_ACTIVE_LEVEL : !BQ_CE_ACTIVE_LEVEL);
  if (pin == PIN_BQ1_CE) {
    bq1CeOn = on;
  } else if (pin == PIN_BQ2_CE) {
    bq2CeOn = on;
  }
  Serial.printf("%s CE GPIO%u: %s\n", name, pin, on ? "ASSERTED / CHARGE ALLOWED" : "INACTIVE / CHARGE BLOCKED");
}

const char *channelName(uint8_t channelNumber) {
  return (channelNumber == 1) ? "Cell A / CH1" : "Cell B / CH2";
}

void setPWMChannel(uint8_t channelNumber, uint8_t duty) {
  (void)trySetPWMChannel(channelNumber, duty);
}

bool trySetPWMChannel(uint8_t channelNumber, uint8_t duty) {
  gLastActionError[0] = '\0';
  const uint8_t pin = (channelNumber == 1) ? PIN_DCHG_PWM_CH1 : PIN_DCHG_PWM_CH2;
  const uint8_t ledcChannel = (channelNumber == 1) ? PWM_CHANNEL_1 : PWM_CHANNEL_2;
  const uint8_t currentDuty = (channelNumber == 1) ? pwm1Duty : pwm2Duty;

  if (duty == currentDuty) {
    return true;
  }

  if (duty > 0) {
    const bool chargeEnabled = (channelNumber == 1) ? bq1CeOn : bq2CeOn;
    if (chargeEnabled) {
      snprintf(gLastActionError, sizeof(gLastActionError),
               "Discharge blocked: charger CE asserted on %s. Disable charge first.",
               channelName(channelNumber));
      Serial.println(gLastActionError);
      return false;
    }

    uint16_t cellVoltageMv = 0;
    if (!readChannelCellVoltageMv(channelNumber, cellVoltageMv)) {
      snprintf(gLastActionError, sizeof(gLastActionError),
               "Discharge blocked: could not read cell voltage on %s.",
               channelName(channelNumber));
      Serial.println(gLastActionError);
      return false;
    }
    if (cellVoltageMv < CELL_PRESENT_MIN_MV) {
      snprintf(gLastActionError, sizeof(gLastActionError),
               "Discharge blocked: cell voltage %u mV below %u mV on %s.",
               cellVoltageMv,
               CELL_PRESENT_MIN_MV,
               channelName(channelNumber));
      Serial.println(gLastActionError);
      return false;
    }

    Serial.println(F("WARNING: nonzero discharge PWM can discharge a connected cell. Make sure load resistor/heatsink/cell wiring are safe."));
  }

  writePwm(pin, ledcChannel, duty);
  if (channelNumber == 1) {
    pwm1Duty = duty;
  } else {
    pwm2Duty = duty;
  }
  Serial.printf("Discharge PWM CH%u duty: %u / 255\n", channelNumber, duty);
  return true;
}

void setRS485Mode(bool transmit) {
  rs485TransmitMode = transmit;
  digitalWrite(PIN_RS485_RE_DE, transmit ? HIGH : LOW);
}

void setAllOutputsOff() {
  // Safety first: disable all hardware paths that can move power or current.
  digitalWrite(PIN_FAN_MOSFET, LOW);
  fanOn = false;

  digitalWrite(PIN_BQ1_CE, !BQ_CE_ACTIVE_LEVEL);
  digitalWrite(PIN_BQ2_CE, !BQ_CE_ACTIVE_LEVEL);
  bq1CeOn = false;
  bq2CeOn = false;

  writePwm(PIN_DCHG_PWM_CH1, PWM_CHANNEL_1, 0);
  writePwm(PIN_DCHG_PWM_CH2, PWM_CHANNEL_2, 0);
  pwm1Duty = 0;
  pwm2Duty = 0;

  setRS485Mode(false);
  setLedColor(0, 0, 0);

  Serial.println(F("ALL OUTPUTS OFF: fan off, BQ CE inactive, PWM duties 0, RS485 receive mode, LED off."));
}

void printBanner() {
  Serial.println();
  Serial.println(F("ESP32-S2 Mini-2 Battery Cell Tester Bring-Up Firmware"));
  Serial.printf("Build: %s %s\n", __DATE__, __TIME__);
  Serial.printf("Chip: %s\n", ESP.getChipModel());
  Serial.printf("CPU frequency: %u MHz\n", ESP.getCpuFreqMHz());
  Serial.printf("Flash size: %u bytes\n", ESP.getFlashChipSize());
  Serial.printf("Reset reason: %s\n", resetReasonToString(esp_reset_reason()).c_str());
  Serial.println();
}

void printHelp() {
  Serial.println(F("Commands:"));
  Serial.println(F("  h | help"));
  Serial.println(F("  status"));
  Serial.println(F("  scan | scan1 | scan2"));
  Serial.println(F("  devices"));
  Serial.println(F("  ads [0-3]"));
  Serial.println(F("  ina"));
  Serial.println(F("  bq1 | bq2"));
  Serial.println(F("  bq1 safe | bq2 safe"));
  Serial.println(F("  bq1 adc on|off | bq2 adc on|off"));
  Serial.println(F("  bq1 ichg <80-3000 mA, exact 80 mA step> | bq2 ichg <...>"));
  Serial.println(F("  bq1 charge on|off | bq2 charge on|off"));
  Serial.println(F("  i2c read1 <addr> <reg>"));
  Serial.println(F("  i2c read2 <addr> <reg>"));
  Serial.println(F("  i2c write1 <addr> <reg> <value>"));
  Serial.println(F("  i2c write2 <addr> <reg> <value>"));
  Serial.println(F("  fan on | fan off | fan auto"));
  Serial.println(F("  int"));
  Serial.println(F("  led r | led g | led b | led w | led off"));
  Serial.println(F("  rs485 tx <text>"));
  Serial.println(F("  pwm1 <0-255>"));
  Serial.println(F("  pwm2 <0-255>"));
  Serial.println(F("  alloff"));
  printWifiHelpLine();
}

int scanI2CBus(TwoWire &bus, const char *name) {
  int found = 0;
  Serial.printf("Scanning %s at 100 kHz...\n", name);

  for (uint8_t address = 0x03; address <= 0x77; address++) {
    bus.beginTransmission(address);
    const uint8_t error = bus.endTransmission();
    if (error == 0) {
      Serial.printf("  %s device at 0x%02X\n", name, address);
      found++;
    }
  }

  Serial.printf("%s scan complete: %d device(s) found.\n", name, found);
  return found;
}

bool parseNumberToken(const String &token, uint32_t maxValue, uint8_t &value) {
  if (token.length() == 0) {
    return false;
  }

  char *end = nullptr;
  const uint32_t parsed = strtoul(token.c_str(), &end, 0);
  if ((end == token.c_str()) || (*end != '\0') || (parsed > maxValue)) {
    return false;
  }

  value = static_cast<uint8_t>(parsed);
  return true;
}

bool parseNumberToken16(const String &token, uint16_t minValue, uint16_t maxValue, uint16_t &value) {
  if (token.length() == 0) {
    return false;
  }

  char *end = nullptr;
  const uint32_t parsed = strtoul(token.c_str(), &end, 0);
  if ((end == token.c_str()) || (*end != '\0') || (parsed < minValue) || (parsed > maxValue)) {
    return false;
  }

  value = static_cast<uint16_t>(parsed);
  return true;
}

bool readI2CRegister(TwoWire &bus, const char *busName, uint8_t address, uint8_t reg, uint8_t &value) {
  bus.beginTransmission(address);
  bus.write(reg);
  uint8_t error = bus.endTransmission(false);
  if (error != 0) {
    Serial.printf("%s read failed: address 0x%02X register 0x%02X write phase error %u\n", busName, address, reg, error);
    return false;
  }

  const uint8_t received = bus.requestFrom(static_cast<int>(address), 1);
  if (received != 1) {
    Serial.printf("%s read failed: address 0x%02X register 0x%02X returned %u byte(s)\n", busName, address, reg, received);
    return false;
  }

  value = bus.read();
  Serial.printf("%s read: address 0x%02X register 0x%02X = 0x%02X (%u)\n", busName, address, reg, value, value);
  return true;
}

bool readI2CRegisterQuiet(TwoWire &bus, const char *busName, uint8_t address, uint8_t reg, uint8_t &value) {
  if (!i2cLock()) {
    return false;
  }

  bus.beginTransmission(address);
  bus.write(reg);
  uint8_t error = bus.endTransmission(false);
  if (error != 0) {
    Serial.printf("%s read failed: address 0x%02X register 0x%02X write phase error %u\n", busName, address, reg, error);
    i2cUnlock();
    return false;
  }

  const uint8_t received = bus.requestFrom(static_cast<int>(address), 1);
  if (received != 1) {
    Serial.printf("%s read failed: address 0x%02X register 0x%02X returned %u byte(s)\n", busName, address, reg, received);
    i2cUnlock();
    return false;
  }

  value = bus.read();
  i2cUnlock();
  return true;
}

bool writeI2CRegister(TwoWire &bus, const char *busName, uint8_t address, uint8_t reg, uint8_t value) {
  if (!i2cLock()) {
    return false;
  }

  bus.beginTransmission(address);
  bus.write(reg);
  bus.write(value);
  const uint8_t error = bus.endTransmission();
  if (error != 0) {
    Serial.printf("%s write failed: address 0x%02X register 0x%02X value 0x%02X error %u\n", busName, address, reg, value, error);
    i2cUnlock();
    return false;
  }

  Serial.printf("%s write: address 0x%02X register 0x%02X <= 0x%02X (%u)\n", busName, address, reg, value, value);
  i2cUnlock();
  return true;
}

bool readI2CRegister16BE(TwoWire &bus, const char *busName, uint8_t address, uint8_t reg, uint16_t &value) {
  if (!i2cLock()) {
    return false;
  }

  bus.beginTransmission(address);
  bus.write(reg);
  uint8_t error = bus.endTransmission(false);
  if (error != 0) {
    Serial.printf("%s 16-bit read failed: address 0x%02X register 0x%02X write phase error %u\n", busName, address, reg, error);
    i2cUnlock();
    return false;
  }

  const uint8_t received = bus.requestFrom(static_cast<int>(address), 2);
  if (received != 2) {
    Serial.printf("%s 16-bit read failed: address 0x%02X register 0x%02X returned %u byte(s)\n", busName, address, reg, received);
    i2cUnlock();
    return false;
  }

  const uint8_t msb = bus.read();
  const uint8_t lsb = bus.read();
  value = (static_cast<uint16_t>(msb) << 8) | lsb;
  i2cUnlock();
  return true;
}

bool writeI2CRegister16BE(TwoWire &bus, const char *busName, uint8_t address, uint8_t reg, uint16_t value) {
  if (!i2cLock()) {
    return false;
  }

  bus.beginTransmission(address);
  bus.write(reg);
  bus.write(static_cast<uint8_t>(value >> 8));
  bus.write(static_cast<uint8_t>(value & 0xFF));
  const uint8_t error = bus.endTransmission();
  if (error != 0) {
    Serial.printf("%s 16-bit write failed: address 0x%02X register 0x%02X value 0x%04X error %u\n", busName, address, reg, value, error);
    i2cUnlock();
    return false;
  }

  i2cUnlock();
  return true;
}

// ---------------------------------------------------------------------------
// Software (bit-banged) I2C for bus 2 on PIN_I2C2_SDA / PIN_I2C2_SCL.
// ---------------------------------------------------------------------------
static portMUX_TYPE sw2BusMux = portMUX_INITIALIZER_UNLOCKED;

static void sw2Delay() { delayMicroseconds(5); }

static inline void sw2SdaHigh() { pinMode(PIN_I2C2_SDA, INPUT_PULLUP); }
static inline void sw2SdaLow() { pinMode(PIN_I2C2_SDA, OUTPUT); digitalWrite(PIN_I2C2_SDA, LOW); }
static inline void sw2SclHigh() { pinMode(PIN_I2C2_SCL, INPUT_PULLUP); }
static inline void sw2SclLow() { pinMode(PIN_I2C2_SCL, OUTPUT); digitalWrite(PIN_I2C2_SCL, LOW); }
static inline bool sw2SdaRead() { return digitalRead(PIN_I2C2_SDA) != 0; }

static void sw2Init() {
  sw2SdaHigh();
  sw2SclHigh();
  sw2Delay();
}

static void sw2Start() {
  sw2SdaHigh();
  sw2SclHigh();
  sw2Delay();
  sw2SdaLow();
  sw2Delay();
  sw2SclLow();
  sw2Delay();
}

static void sw2Stop() {
  sw2SdaLow();
  sw2Delay();
  sw2SclHigh();
  sw2Delay();
  sw2SdaHigh();
  sw2Delay();
}

static bool sw2WriteByte(uint8_t b) {
  for (uint8_t i = 0; i < 8; i++) {
    if (b & 0x80) {
      sw2SdaHigh();
    } else {
      sw2SdaLow();
    }
    b <<= 1;
    sw2Delay();
    sw2SclHigh();
    sw2Delay();
    sw2SclLow();
    sw2Delay();
  }
  sw2SdaHigh();
  sw2Delay();
  sw2SclHigh();
  sw2Delay();
  const bool ack = !sw2SdaRead();
  sw2SclLow();
  sw2Delay();
  return ack;
}

static uint8_t sw2ReadByte(bool sendAck) {
  uint8_t b = 0;
  sw2SdaHigh();
  for (uint8_t i = 0; i < 8; i++) {
    sw2Delay();
    sw2SclHigh();
    sw2Delay();
    b = static_cast<uint8_t>((b << 1) | (sw2SdaRead() ? 1 : 0));
    sw2SclLow();
  }
  if (sendAck) {
    sw2SdaLow();
  } else {
    sw2SdaHigh();
  }
  sw2Delay();
  sw2SclHigh();
  sw2Delay();
  sw2SclLow();
  sw2Delay();
  sw2SdaHigh();
  return b;
}

static bool sw2Probe(uint8_t address7) {
  portENTER_CRITICAL(&sw2BusMux);
  sw2Start();
  const bool ack = sw2WriteByte(static_cast<uint8_t>((address7 << 1) | 0));
  sw2Stop();
  portEXIT_CRITICAL(&sw2BusMux);
  return ack;
}

int scanI2C2Software(const char *name) {
  int found = 0;
  Serial.printf("Scanning %s at 100 kHz (software)...\n", name);
  for (uint8_t address = 0x03; address <= 0x77; address++) {
    if (sw2Probe(address)) {
      Serial.printf("  %s device at 0x%02X\n", name, address);
      found++;
    }
  }
  Serial.printf("%s scan complete: %d device(s) found.\n", name, found);
  return found;
}

bool readI2C2Software(const char *busName, uint8_t address, uint8_t reg, uint8_t &value) {
  portENTER_CRITICAL(&sw2BusMux);
  sw2Start();
  if (!sw2WriteByte(static_cast<uint8_t>((address << 1) | 0))) {
    sw2Stop();
    portEXIT_CRITICAL(&sw2BusMux);
    Serial.printf("%s read failed: address 0x%02X not acked (write phase)\n", busName, address);
    return false;
  }
  if (!sw2WriteByte(reg)) {
    sw2Stop();
    portEXIT_CRITICAL(&sw2BusMux);
    Serial.printf("%s read failed: register 0x%02X not acked\n", busName, reg);
    return false;
  }
  sw2Start();
  if (!sw2WriteByte(static_cast<uint8_t>((address << 1) | 1))) {
    sw2Stop();
    portEXIT_CRITICAL(&sw2BusMux);
    Serial.printf("%s read failed: address 0x%02X not acked (read phase)\n", busName, address);
    return false;
  }
  value = sw2ReadByte(false);
  sw2Stop();
  portEXIT_CRITICAL(&sw2BusMux);
  Serial.printf("%s read: address 0x%02X register 0x%02X = 0x%02X (%u)\n", busName, address, reg, value, value);
  return true;
}

bool writeI2C2Software(const char *busName, uint8_t address, uint8_t reg, uint8_t value) {
  portENTER_CRITICAL(&sw2BusMux);
  sw2Start();
  if (!sw2WriteByte(static_cast<uint8_t>((address << 1) | 0))) {
    sw2Stop();
    portEXIT_CRITICAL(&sw2BusMux);
    Serial.printf("%s write failed: address 0x%02X not acked\n", busName, address);
    return false;
  }
  if (!sw2WriteByte(reg)) {
    sw2Stop();
    portEXIT_CRITICAL(&sw2BusMux);
    Serial.printf("%s write failed: register 0x%02X not acked\n", busName, reg);
    return false;
  }
  if (!sw2WriteByte(value)) {
    sw2Stop();
    portEXIT_CRITICAL(&sw2BusMux);
    Serial.printf("%s write failed: data 0x%02X not acked\n", busName, value);
    return false;
  }
  sw2Stop();
  portEXIT_CRITICAL(&sw2BusMux);
  Serial.printf("%s write: address 0x%02X register 0x%02X <= 0x%02X (%u)\n", busName, address, reg, value, value);
  return true;
}

bool readI2C2SoftwareBytes(const char *busName, uint8_t address, uint8_t reg, uint8_t *buffer, uint8_t length) {
  if ((buffer == nullptr) || (length == 0)) {
    return false;
  }

  portENTER_CRITICAL(&sw2BusMux);
  sw2Start();
  if (!sw2WriteByte(static_cast<uint8_t>((address << 1) | 0))) {
    sw2Stop();
    portEXIT_CRITICAL(&sw2BusMux);
    Serial.printf("%s read failed: address 0x%02X not acked (write phase)\n", busName, address);
    return false;
  }
  if (!sw2WriteByte(reg)) {
    sw2Stop();
    portEXIT_CRITICAL(&sw2BusMux);
    Serial.printf("%s read failed: register 0x%02X not acked\n", busName, reg);
    return false;
  }
  sw2Start();
  if (!sw2WriteByte(static_cast<uint8_t>((address << 1) | 1))) {
    sw2Stop();
    portEXIT_CRITICAL(&sw2BusMux);
    Serial.printf("%s read failed: address 0x%02X not acked (read phase)\n", busName, address);
    return false;
  }
  for (uint8_t i = 0; i < length; i++) {
    buffer[i] = sw2ReadByte(i < (length - 1));
  }
  sw2Stop();
  portEXIT_CRITICAL(&sw2BusMux);
  return true;
}

bool writeI2C2SoftwareBytes(const char *busName, uint8_t address, uint8_t reg, const uint8_t *data, size_t length) {
  sw2Start();
  if (!sw2WriteByte(static_cast<uint8_t>(address << 1))) {
    Serial.printf("%s write failed: address 0x%02X NACK on address\n", busName, address);
    sw2Stop();
    return false;
  }
  if (!sw2WriteByte(reg)) {
    Serial.printf("%s write failed: address 0x%02X NACK on register 0x%02X\n", busName, address, reg);
    sw2Stop();
    return false;
  }
  for (size_t i = 0; i < length; i++) {
    if (!sw2WriteByte(data[i])) {
      Serial.printf("%s write failed: address 0x%02X NACK on data byte %zu\n", busName, address, i);
      sw2Stop();
      return false;
    }
  }
  sw2Stop();
  return true;
}

bool readI2C2Software16LE(const char *busName, uint8_t address, uint8_t reg, uint16_t &value) {
  uint8_t bytes[2] = {0, 0};
  if (!readI2C2SoftwareBytes(busName, address, reg, bytes, sizeof(bytes))) {
    return false;
  }

  value = static_cast<uint16_t>(bytes[0]) | (static_cast<uint16_t>(bytes[1]) << 8);
  return true;
}

bool writeI2CRegister16LE(TwoWire &bus, const char *busName, uint8_t address, uint8_t reg, uint16_t value) {
  if (!i2cLock()) {
    return false;
  }

  bus.beginTransmission(address);
  bus.write(reg);
  bus.write(static_cast<uint8_t>(value & 0xFF));
  bus.write(static_cast<uint8_t>(value >> 8));
  uint8_t error = bus.endTransmission(true);
  i2cUnlock();

  if (error != 0) {
    Serial.printf("%s 16-bit write failed: address 0x%02X register 0x%02X error %u\n", busName, address, reg, error);
    return false;
  }
  return true;
}

bool readI2CRegister16LEByBytes(TwoWire &bus, const char *busName, uint8_t address, uint8_t reg, uint16_t &value) {
  uint8_t low = 0;
  uint8_t high = 0;
  if (!readI2CRegisterQuiet(bus, busName, address, reg, low) || !readI2CRegisterQuiet(bus, busName, address, static_cast<uint8_t>(reg + 1), high)) {
    return false;
  }

  value = static_cast<uint16_t>(low) | (static_cast<uint16_t>(high) << 8);
  return true;
}

const char *bqBusName(uint8_t chargerNumber) {
  return (chargerNumber == 1) ? "BQ1/I2C1" : "BQ2/I2C2";
}

bool bqReadByte(uint8_t chargerNumber, uint8_t reg, uint8_t &value) {
  if (chargerNumber == 1) {
    return readI2CRegisterQuiet(I2C1, bqBusName(chargerNumber), BQ25622_ADDR, reg, value);
  }

  if (!i2cLock()) {
    return false;
  }
  const bool ok = readI2C2SoftwareBytes(bqBusName(chargerNumber), BQ25622_ADDR, reg, &value, 1);
  i2cUnlock();
  return ok;
}

bool bqWriteByte(uint8_t chargerNumber, uint8_t reg, uint8_t value) {
  if (chargerNumber == 1) {
    return writeI2CRegister(I2C1, bqBusName(chargerNumber), BQ25622_ADDR, reg, value);
  }

  if (!i2cLock()) {
    return false;
  }
  const bool ok = writeI2C2Software(bqBusName(chargerNumber), BQ25622_ADDR, reg, value);
  i2cUnlock();
  return ok;
}

bool bqWrite16LE(uint8_t chargerNumber, uint8_t reg, uint16_t value) {
  if (chargerNumber == 1) {
    return writeI2CRegister16LE(I2C1, bqBusName(chargerNumber), BQ25622_ADDR, reg, value);
  }

  if (!i2cLock()) {
    return false;
  }
  // Software I2C doesn't have a 16-bit write helper yet, so we write two bytes
  uint8_t bytes[2] = {static_cast<uint8_t>(value & 0xFF), static_cast<uint8_t>(value >> 8)};
  bool ok = writeI2C2SoftwareBytes(bqBusName(chargerNumber), BQ25622_ADDR, reg, bytes, 2);
  i2cUnlock();
  return ok;
}

bool bqRead16LE(uint8_t chargerNumber, uint8_t reg, uint16_t &value) {
  if (chargerNumber == 1) {
    return readI2CRegister16LEByBytes(I2C1, bqBusName(chargerNumber), BQ25622_ADDR, reg, value);
  }

  if (!i2cLock()) {
    return false;
  }
  const bool ok = readI2C2Software16LE(bqBusName(chargerNumber), BQ25622_ADDR, reg, value);
  i2cUnlock();
  return ok;
}

bool readChannelCellVoltageMv(uint8_t channelNumber, uint16_t &voltageMv) {
  uint16_t raw = 0;
  const uint8_t inaAddress = (channelNumber == 1) ? INA226_ADDR_1 : INA226_ADDR_2;
  if (!readI2CRegister16BE(I2C1, "INA226/I2C1", inaAddress, INA226_REG_BUS_VOLTAGE, raw)) {
    return false;
  }

  // INA226 bus voltage is 1.25 mV/LSB and is Kelvin-sensed at the cell terminals.
  const uint32_t millivolts = (static_cast<uint32_t>(raw) * 125UL + 50UL) / 100UL;
  if (millivolts > UINT16_MAX) {
    return false;
  }
  voltageMv = static_cast<uint16_t>(millivolts);
  return true;
}

uint8_t dischargeDutyForChannel(uint8_t channelNumber) {
  return (channelNumber == 1) ? pwm1Duty : pwm2Duty;
}

bool bqUpdateControl1(uint8_t chargerNumber, uint8_t setMask, uint8_t clearMask) {
  uint8_t control = 0;
  if (!bqReadByte(chargerNumber, BQ25622_REG_CHARGER_CONTROL_1, control)) {
    return false;
  }

  control = (control | setMask) & ~clearMask;
  return bqWriteByte(chargerNumber, BQ25622_REG_CHARGER_CONTROL_1, control);
}

bool bqReadChargeCurrentLimitMa(uint8_t chargerNumber, uint16_t &currentMa) {
  uint8_t reg02 = 0;
  uint8_t reg03 = 0;
  if (!bqReadByte(chargerNumber, BQ25622_REG_CHARGE_CURRENT_LIMIT, reg02) ||
      !bqReadByte(chargerNumber, static_cast<uint8_t>(BQ25622_REG_CHARGE_CURRENT_LIMIT + 1), reg03)) {
    return false;
  }

  const uint8_t steps = static_cast<uint8_t>(((reg03 & 0x0F) << 2) | (reg02 >> 6));
  currentMa = static_cast<uint16_t>(steps) * BQ25622_ICHG_STEP_MA;
  return true;
}

bool setBQChargeCurrentLimit(uint8_t chargerNumber, uint16_t requestedMa) {
  gLastActionError[0] = '\0';
  if ((requestedMa < BQ25622_ICHG_MIN_MA) || (requestedMa > BQ25622_ICHG_MAX_MA)) {
    snprintf(gLastActionError, sizeof(gLastActionError), "ICHG invalid: use %u-%u mA",
             BQ25622_ICHG_MIN_MA, BQ25622_ICHG_MAX_MA);
    Serial.printf("%s %s\n", bqBusName(chargerNumber), gLastActionError);
    return false;
  }
  if ((requestedMa % BQ25622_ICHG_STEP_MA) != 0) {
    const uint16_t lower = static_cast<uint16_t>((requestedMa / BQ25622_ICHG_STEP_MA) * BQ25622_ICHG_STEP_MA);
    const uint16_t upper = static_cast<uint16_t>(lower + BQ25622_ICHG_STEP_MA);
    snprintf(gLastActionError, sizeof(gLastActionError),
             "ICHG %u mA is not exactly representable. Use %u mA steps (e.g. %u or %u).",
             requestedMa,
             BQ25622_ICHG_STEP_MA,
             lower,
             upper);
    Serial.printf("%s %s\n", bqBusName(chargerNumber), gLastActionError);
    return false;
  }

  const uint8_t steps = static_cast<uint8_t>(requestedMa / BQ25622_ICHG_STEP_MA);
  uint8_t reg02 = 0;
  uint8_t reg03 = 0;
  if (!bqReadByte(chargerNumber, BQ25622_REG_CHARGE_CURRENT_LIMIT, reg02) ||
      !bqReadByte(chargerNumber, static_cast<uint8_t>(BQ25622_REG_CHARGE_CURRENT_LIMIT + 1), reg03)) {
    return false;
  }

  reg02 = static_cast<uint8_t>((reg02 & 0x3F) | ((steps & 0x03) << 6));
  reg03 = static_cast<uint8_t>((reg03 & 0xF0) | ((steps >> 2) & 0x0F));
  if (!bqWriteByte(chargerNumber, BQ25622_REG_CHARGE_CURRENT_LIMIT, reg02) ||
      !bqWriteByte(chargerNumber, static_cast<uint8_t>(BQ25622_REG_CHARGE_CURRENT_LIMIT + 1), reg03)) {
    return false;
  }

  Serial.printf("%s ICHG set exactly to %u mA (%u mA steps)\n",
                bqBusName(chargerNumber),
                requestedMa,
                BQ25622_ICHG_STEP_MA);
  return true;
}

bool bqReadPrechargeCurrentLimitMa(uint8_t chargerNumber, uint16_t &currentMa) {
  uint16_t raw = 0;
  if (!bqRead16LE(chargerNumber, BQ25622_REG_PRECHARGE_CONTROL, raw)) {
    return false;
  }

  const uint8_t steps = static_cast<uint8_t>((raw >> 4) & 0x1F);
  currentMa = static_cast<uint16_t>(steps) * BQ25622_IPRECHG_STEP_MA;
  return true;
}

bool setBQPrechargeCurrentLimit(uint8_t chargerNumber, uint16_t requestedMa) {
  if ((requestedMa < BQ25622_IPRECHG_STEP_MA) || (requestedMa > BQ25622_PRECHARGE_MAX_MA) ||
      ((requestedMa % BQ25622_IPRECHG_STEP_MA) != 0)) {
    Serial.printf("%s IPRECHG invalid: use 20-%u mA in %u mA steps\n",
                  bqBusName(chargerNumber),
                  BQ25622_PRECHARGE_MAX_MA,
                  BQ25622_IPRECHG_STEP_MA);
    return false;
  }

  uint16_t raw = 0;
  if (!bqRead16LE(chargerNumber, BQ25622_REG_PRECHARGE_CONTROL, raw)) {
    return false;
  }

  const uint16_t steps = requestedMa / BQ25622_IPRECHG_STEP_MA;
  raw = static_cast<uint16_t>((raw & ~0x01F0U) | ((steps & 0x1FU) << 4));
  if (!bqWrite16LE(chargerNumber, BQ25622_REG_PRECHARGE_CONTROL, raw)) {
    return false;
  }

  Serial.printf("%s IPRECHG set to %u mA\n", bqBusName(chargerNumber), requestedMa);
  return true;
}

void setBQChargeEnable(uint8_t chargerNumber, bool enabled) {
  (void)trySetBQChargeEnable(chargerNumber, enabled);
}

void disableBQBatfet(uint8_t chargerNumber);
void enableBQBatfet(uint8_t chargerNumber);

void enableBQBatfet(uint8_t chargerNumber) {
  uint8_t control3 = 0;
  if (!bqReadByte(chargerNumber, BQ25622_REG_CHARGER_CONTROL_3, control3)) {
    Serial.printf("%s failed to read REG0x18 for BATFET enable\n", bqBusName(chargerNumber));
    return;
  }
  
  // Clear BATFET_CTRL bits (1:0) to 00 to turn BATFET on
  uint8_t newValue = control3 & 0xFC;
  
  if (!bqWriteByte(chargerNumber, BQ25622_REG_CHARGER_CONTROL_3, newValue)) {
    Serial.printf("%s failed to write REG0x18 for BATFET enable\n", bqBusName(chargerNumber));
    return;
  }
  
  delay(50);
  
  uint8_t readback = 0;
  if (bqReadByte(chargerNumber, BQ25622_REG_CHARGER_CONTROL_3, readback)) {
    if ((readback & 0x03) == 0x00) {
      Serial.printf("%s BATFET successfully enabled (REG0x18 = 0x%02X)\n", bqBusName(chargerNumber), readback);
    } else {
      Serial.printf("%s WARNING: BATFET enable did not stick! Read back REG0x18 = 0x%02X\n", bqBusName(chargerNumber), readback);
    }
  }
}

bool trySetBQChargeEnable(uint8_t chargerNumber, bool enabled) {
  gLastActionError[0] = '\0';
  Serial.printf("%s charge control request: %s\n", bqBusName(chargerNumber), enabled ? "ENABLE" : "DISABLE");
  if (enabled) {
    Serial.println(F("WARNING: enabling BQ charging can move current into a connected cell. Verify chemistry, polarity, current limits, and temperature sensing first."));
  }

  const uint8_t cePin = (chargerNumber == 1) ? PIN_BQ1_CE : PIN_BQ2_CE;
  const char *ceName = (chargerNumber == 1) ? "BQ1" : "BQ2";

  if (enabled) {
    const uint8_t dischargeDuty = dischargeDutyForChannel(chargerNumber);
    if (dischargeDuty > 0) {
      snprintf(gLastActionError, sizeof(gLastActionError),
               "Charge blocked: discharge PWM duty %u on %s. Set pwm%u 0 first.",
               dischargeDuty,
               channelName(chargerNumber),
               chargerNumber);
      Serial.println(gLastActionError);
      return false;
    }

    uint16_t cellVoltageMv = 0;
    if (!readChannelCellVoltageMv(chargerNumber, cellVoltageMv)) {
      snprintf(gLastActionError, sizeof(gLastActionError),
               "Charge blocked: could not read cell voltage on %s.",
               channelName(chargerNumber));
      Serial.println(gLastActionError);
      return false;
    }
    if (cellVoltageMv < CELL_PRESENT_MIN_MV) {
      snprintf(gLastActionError, sizeof(gLastActionError),
               "Charge blocked: cell voltage %u mV below %u mV on %s.",
               cellVoltageMv,
               CELL_PRESENT_MIN_MV,
               channelName(chargerNumber));
      Serial.println(gLastActionError);
      return false;
    }

    uint16_t chargeCurrentMa = 0;
    if (!bqReadChargeCurrentLimitMa(chargerNumber, chargeCurrentMa)) {
      snprintf(gLastActionError, sizeof(gLastActionError),
               "Charge blocked: could not read ICHG limit on %s.",
               channelName(chargerNumber));
      Serial.println(gLastActionError);
      return false;
    }
    if (chargeCurrentMa > BQ25622_ICHG_MAX_MA) {
      snprintf(gLastActionError, sizeof(gLastActionError),
               "Charge blocked: ICHG limit %u mA exceeds firmware limit %u mA.",
               chargeCurrentMa,
               BQ25622_ICHG_MAX_MA);
      Serial.println(gLastActionError);
      return false;
    }

    if (!bqUpdateControl1(chargerNumber, BQ25622_CONTROL1_EN_CHG, BQ25622_CONTROL1_WATCHDOG_MASK)) {
      snprintf(gLastActionError, sizeof(gLastActionError), "Charge blocked: failed to update charger control.");
      Serial.println(gLastActionError);
      return false;
    }
    setBQCE(cePin, true, ceName);
    enableBQBatfet(chargerNumber);
    return true;
  }

  setBQCE(cePin, false, ceName);
  bqUpdateControl1(chargerNumber, 0, BQ25622_CONTROL1_EN_CHG | BQ25622_CONTROL1_WATCHDOG_MASK);
  disableBQBatfet(chargerNumber);
  return true;
}

void setBQAdc(uint8_t chargerNumber, bool enabled) {
  const uint8_t value = enabled ? (BQ25622_ADC_CONTROL_EN | BQ25622_ADC_CONTROL_12BIT_CONTINUOUS) : BQ25622_ADC_CONTROL_DEFAULT;
  if (bqWriteByte(chargerNumber, BQ25622_REG_ADC_CONTROL, value)) {
    Serial.printf("%s ADC: %s\n", bqBusName(chargerNumber), enabled ? "enabled, continuous 12-bit" : "disabled");
  }
}

void disableBQBatfet(uint8_t chargerNumber) {
  uint8_t control3 = 0;
  if (!bqReadByte(chargerNumber, BQ25622_REG_CHARGER_CONTROL_3, control3)) {
    Serial.printf("%s failed to read REG0x18 for BATFET disable\n", bqBusName(chargerNumber));
    return;
  }
  
  // Bit 3: BATFET_CTRL_WVBUS = 1 (allow BATFET off with adapter present)
  // Bit 2: BATFET_DLY = 0 (25ms delay instead of 12.5s)
  // Bits 1:0: BATFET_CTRL = 10 (Ship mode / BATFET off)
  uint8_t newValue = (control3 & 0xF0) | 0x0A;
  
  if (!bqWriteByte(chargerNumber, BQ25622_REG_CHARGER_CONTROL_3, newValue)) {
    Serial.printf("%s failed to write REG0x18 for BATFET disable\n", bqBusName(chargerNumber));
    return;
  }
  
  delay(50); // Wait for the 25ms delay to pass
  
  uint8_t readback = 0;
  if (bqReadByte(chargerNumber, BQ25622_REG_CHARGER_CONTROL_3, readback)) {
    if ((readback & 0x0F) == 0x0A) {
      Serial.printf("%s BATFET successfully disabled (REG0x18 = 0x%02X)\n", bqBusName(chargerNumber), readback);
    } else {
      Serial.printf("%s WARNING: BATFET disable did not stick! Read back REG0x18 = 0x%02X (expected lower nibble 0xA)\n", bqBusName(chargerNumber), readback);
    }
  }
}

const CellChemistryProfile &batteryChemistryProfile() {
  return (gCellChemistry == CellChemistry::NMC_18650) ? NMC_18650_PROFILE : LIFEPO4_PROFILE;
}

static const CellChemistryProfile &profileForChemistry(CellChemistry chemistry) {
  return (chemistry == CellChemistry::NMC_18650) ? NMC_18650_PROFILE : LIFEPO4_PROFILE;
}

void initializeBatteryChemistry() {
  Preferences preferences;
  if (!preferences.begin("battery", true)) {
    Serial.println(F("Chemistry: could not open flash settings; defaulting to LiFePO4."));
    gCellChemistry = CellChemistry::LIFEPO4;
    return;
  }
  const String saved = preferences.getString("chemistry", LIFEPO4_PROFILE.id);
  preferences.end();
  gCellChemistry = (saved == NMC_18650_PROFILE.id) ? CellChemistry::NMC_18650 : CellChemistry::LIFEPO4;
  Serial.printf("Chemistry: loaded %s from flash\n", batteryChemistryProfile().label);
}

static bool applyBQChemistryProfile(uint8_t chargerNumber, const CellChemistryProfile &profile) {
  const uint16_t minimumSystemRaw =
      static_cast<uint16_t>((profile.minimumSystemVoltageMv / 80U) << 6);
  const uint16_t chargeVoltageRaw =
      static_cast<uint16_t>((profile.maxChargeVoltageMv / 10U) << 3);
  const uint16_t terminationRaw = static_cast<uint16_t>((100U / 10U) << 3);

  bool ok = true;
  ok = bqWrite16LE(chargerNumber, BQ25622_REG_MINIMAL_SYSTEM_VOLTAGE, minimumSystemRaw) && ok;
  ok = setBQPrechargeCurrentLimit(chargerNumber, profile.prechargeCurrentMa) && ok;
  ok = bqWrite16LE(chargerNumber, BQ25622_REG_CHARGE_VOLTAGE_LIMIT, chargeVoltageRaw) && ok;
  ok = bqWrite16LE(chargerNumber, BQ25622_REG_TERMINATION_CONTROL, terminationRaw) && ok;
  uint16_t minimumSystemReadback = 0;
  uint16_t prechargeReadback = 0;
  uint16_t chargeVoltageReadback = 0;
  uint16_t terminationReadback = 0;
  ok = bqRead16LE(chargerNumber, BQ25622_REG_MINIMAL_SYSTEM_VOLTAGE, minimumSystemReadback) && ok;
  ok = bqRead16LE(chargerNumber, BQ25622_REG_PRECHARGE_CONTROL, prechargeReadback) && ok;
  ok = bqRead16LE(chargerNumber, BQ25622_REG_CHARGE_VOLTAGE_LIMIT, chargeVoltageReadback) && ok;
  ok = bqRead16LE(chargerNumber, BQ25622_REG_TERMINATION_CONTROL, terminationReadback) && ok;
  const uint16_t expectedPrecharge =
      static_cast<uint16_t>((profile.prechargeCurrentMa / BQ25622_IPRECHG_STEP_MA) << 4);
  ok = ok &&
       minimumSystemReadback == minimumSystemRaw &&
       (prechargeReadback & 0x01F0U) == expectedPrecharge &&
       chargeVoltageReadback == chargeVoltageRaw &&
       terminationReadback == terminationRaw;
  if (ok) {
    Serial.printf("%s %s profile applied: VREG=%u mV, VSYSMIN=%u mV, IPRECHG=%u mA, ITERM=100 mA\n",
                  bqBusName(chargerNumber),
                  profile.label,
                  profile.maxChargeVoltageMv,
                  profile.minimumSystemVoltageMv,
                  profile.prechargeCurrentMa);
  } else {
    Serial.printf("%s failed to apply/verify complete %s profile\n", bqBusName(chargerNumber), profile.label);
  }
  return ok;
}

bool changeBatteryChemistry(CellChemistry chemistry) {
  gLastActionError[0] = '\0';
  if (chemistry != CellChemistry::LIFEPO4 && chemistry != CellChemistry::NMC_18650) {
    snprintf(gLastActionError, sizeof(gLastActionError), "Unsupported battery chemistry.");
    return false;
  }
  if (chemistry == gCellChemistry) {
    return true;
  }
  if (!automationIsIdle()) {
    snprintf(gLastActionError, sizeof(gLastActionError),
             "Stop automation on both channels before changing chemistry.");
    return false;
  }

  const CellChemistry previousChemistry = gCellChemistry;
  const CellChemistryProfile &nextProfile = profileForChemistry(chemistry);
  const CellChemistryProfile &previousProfile = profileForChemistry(previousChemistry);

  setAllOutputsOff();
  trySetBQChargeEnable(1, false);
  trySetBQChargeEnable(2, false);
  const bool applied = applyBQChemistryProfile(1, nextProfile) &&
                       applyBQChemistryProfile(2, nextProfile) &&
                       setBQChargeCurrentLimit(1, nextProfile.chargeCurrentMa) &&
                       setBQChargeCurrentLimit(2, nextProfile.chargeCurrentMa);
  if (!applied) {
    applyBQChemistryProfile(1, previousProfile);
    applyBQChemistryProfile(2, previousProfile);
    setBQChargeCurrentLimit(1, previousProfile.chargeCurrentMa);
    setBQChargeCurrentLimit(2, previousProfile.chargeCurrentMa);
    snprintf(gLastActionError, sizeof(gLastActionError),
             "Failed to apply chemistry to both chargers; previous profile restored.");
    return false;
  }

  Preferences preferences;
  if (!preferences.begin("battery", false) ||
      preferences.putString("chemistry", nextProfile.id) != strlen(nextProfile.id)) {
    preferences.end();
    applyBQChemistryProfile(1, previousProfile);
    applyBQChemistryProfile(2, previousProfile);
    setBQChargeCurrentLimit(1, previousProfile.chargeCurrentMa);
    setBQChargeCurrentLimit(2, previousProfile.chargeCurrentMa);
    snprintf(gLastActionError, sizeof(gLastActionError),
             "Could not save chemistry to flash; previous profile restored.");
    return false;
  }
  preferences.end();
  gCellChemistry = chemistry;
  Serial.printf("Chemistry changed and saved: %s\n", nextProfile.label);
  return true;
}

void makeBQSafe(uint8_t chargerNumber) {
  const CellChemistryProfile &profile = batteryChemistryProfile();
  const uint8_t cePin = (chargerNumber == 1) ? PIN_BQ1_CE : PIN_BQ2_CE;
  const char *ceName = (chargerNumber == 1) ? "BQ1" : "BQ2";
  
  // Force CE pin low (active) to turn the chip fully on so we can communicate and control it,
  // but we will keep charging disabled via I2C registers.
  setBQCE(cePin, true, ceName);
  
  // Disable charging via I2C and disable watchdog
  bqUpdateControl1(chargerNumber, 0, BQ25622_CONTROL1_EN_CHG | BQ25622_CONTROL1_WATCHDOG_MASK);
  setBQChargeCurrentLimit(chargerNumber, profile.chargeCurrentMa);
  setBQAdc(chargerNumber, true);
  
  applyBQChemistryProfile(chargerNumber, profile);
  
  // Disconnect the internal BATFET so it doesn't conduct or leak
  disableBQBatfet(chargerNumber);
}

const char *bqChargeStatusToString(uint8_t status) {
  switch (status) {
    case 0:
      return "not charging / terminated";
    case 1:
      return "trickle/pre/fast charge";
    case 2:
      return "taper charge";
    case 3:
      return "top-off timer";
    default:
      return "unknown";
  }
}

const char *bqVbusStatusToString(uint8_t status) {
  switch (status) {
    case 0:
      return "not powered from VBUS";
    case 4:
      return "unknown adapter";
    case 7:
      return "OTG boost mode";
    default:
      return "reserved/other";
  }
}

void printBQAdcReading(const char *label, int32_t value, const char *unit) {
  Serial.printf("    %-5s %ld %s\n", label, static_cast<long>(value), unit);
}

void printBQStatus(uint8_t chargerNumber) {
  Serial.printf("%s (BQ25622 @ 0x%02X):\n", bqBusName(chargerNumber), BQ25622_ADDR);

  uint8_t partInfo = 0;
  uint8_t control1 = 0;
  uint8_t status1 = 0;
  uint8_t fault0 = 0;
  if (!bqReadByte(chargerNumber, BQ25622_REG_PART_INFORMATION, partInfo) ||
      !bqReadByte(chargerNumber, BQ25622_REG_CHARGER_CONTROL_1, control1) ||
      !bqReadByte(chargerNumber, BQ25622_REG_CHARGER_STATUS_1, status1) ||
      !bqReadByte(chargerNumber, BQ25622_REG_FAULT_STATUS_0, fault0)) {
    Serial.println(F("  BQ read failed."));
    return;
  }

  const uint8_t pn = (partInfo >> 3) & 0x07;
  const uint8_t revision = partInfo & 0x07;
  const uint8_t chgStatus = (status1 >> 3) & 0x03;
  const uint8_t vbusStatus = status1 & 0x07;
  Serial.printf("  part=0x%02X PN=%u (%s) rev=%u\n", partInfo, pn, (pn == 1) ? "BQ25622" : "unexpected", revision);
  Serial.printf("  control1=0x%02X EN_CHG=%u EN_HIZ=%u watchdog=%u\n",
                control1,
                (control1 & BQ25622_CONTROL1_EN_CHG) ? 1 : 0,
                (control1 & BQ25622_CONTROL1_EN_HIZ) ? 1 : 0,
                control1 & BQ25622_CONTROL1_WATCHDOG_MASK);
  Serial.printf("  status1=0x%02X CHG=%s VBUS=%s\n", status1, bqChargeStatusToString(chgStatus), bqVbusStatusToString(vbusStatus));
  Serial.printf("  fault0=0x%02X%s\n", fault0, (fault0 == 0) ? " (no faults)" : "");
  uint16_t ichgMa = 0;
  if (bqReadChargeCurrentLimitMa(chargerNumber, ichgMa)) {
    Serial.printf("  ICHG limit=%u mA\n", ichgMa);
  }
  uint16_t iprechgMa = 0;
  if (bqReadPrechargeCurrentLimitMa(chargerNumber, iprechgMa)) {
    Serial.printf("  IPRECHG limit=%u mA\n", iprechgMa);
  }

  uint16_t raw = 0;
  if (bqRead16LE(chargerNumber, BQ25622_REG_IBUS_ADC, raw)) {
    printBQAdcReading("IBUS", static_cast<int16_t>(raw), "mA");
  }
  if (bqRead16LE(chargerNumber, BQ25622_REG_IBAT_ADC, raw)) {
    printBQAdcReading("IBAT", static_cast<int16_t>(raw), "mA");
  }
  if (bqRead16LE(chargerNumber, BQ25622_REG_VBUS_ADC, raw)) {
    printBQAdcReading("VBUS", static_cast<int32_t>((raw >> 2) & 0x1FFF) * 397L / 100L, "mV");
  }
  if (bqRead16LE(chargerNumber, BQ25622_REG_VPMID_ADC, raw)) {
    printBQAdcReading("VPMID", static_cast<int32_t>((raw >> 2) & 0x1FFF) * 397L / 100L, "mV");
  }
  if (bqRead16LE(chargerNumber, BQ25622_REG_VBAT_ADC, raw)) {
    printBQAdcReading("VBAT", static_cast<int32_t>((raw >> 1) & 0x0FFF) * 199L / 100L, "mV");
  }
  if (bqRead16LE(chargerNumber, BQ25622_REG_VSYS_ADC, raw)) {
    printBQAdcReading("VSYS", static_cast<int32_t>((raw >> 1) & 0x0FFF) * 199L / 100L, "mV");
  }
  if (bqRead16LE(chargerNumber, BQ25622_REG_TDIE_ADC, raw)) {
    printBQAdcReading("TDIE", static_cast<int32_t>(raw >> 1) / 2, "degC approx");
  }
}

bool readADS1115Channel(uint8_t channel, int16_t &counts, float &volts) {
  if (channel > 3) {
    return false;
  }

  const uint16_t mux = static_cast<uint16_t>(0x4000 + (static_cast<uint16_t>(channel) * 0x1000));
  const uint16_t config = 0x8000 | mux | 0x0200 | 0x0100 | 0x0080 | 0x0003; // single-shot, +/-4.096V, 128 SPS, comparator off.
  if (!writeI2CRegister16BE(I2C1, "ADS1115/I2C1", ADS1115_ADDR, ADS1115_REG_CONFIG, config)) {
    return false;
  }

  delay(10);
  uint16_t raw = 0;
  if (!readI2CRegister16BE(I2C1, "ADS1115/I2C1", ADS1115_ADDR, ADS1115_REG_CONVERSION, raw)) {
    return false;
  }

  counts = static_cast<int16_t>(raw);
  volts = static_cast<float>(counts) * 4.096f / 32768.0f;
  return true;
}

const char *adsChannelLabel(uint8_t channel) {
  switch (channel) {
    case 0:
      return "Cell B thermistor";
    case 1:
      return "Heatsink thermistor";
    case 2:
      return "Cell A thermistor";
    case 3:
      return "NC";
    default:
      return "unknown";
  }
}

bool thermistorFromDividerVoltage(float volts, float &resistanceOhms, float &temperatureC) {
  if ((volts <= 0.0f) || (volts >= ADS1115_THERMISTOR_SUPPLY_V)) {
    return false;
  }

  resistanceOhms = THERMISTOR_SERIES_OHMS * volts / (ADS1115_THERMISTOR_SUPPLY_V - volts);
  const float invTemperatureK = (1.0f / THERMISTOR_NOMINAL_K) + (logf(resistanceOhms / THERMISTOR_NOMINAL_OHMS) / THERMISTOR_BETA);
  temperatureC = (1.0f / invTemperatureK) - 273.15f;
  return true;
}

const char *thermistorFaultHint(float volts) {
  if (volts < 0.05f) {
    return "short to GND / missing pull-up";
  }
  if (volts > (ADS1115_THERMISTOR_SUPPLY_V - 0.05f)) {
    return "open / missing thermistor";
  }
  return "thermistor out of range";
}

void printADS1115(uint8_t requestedChannel = 0xFF) {
  Serial.printf("ADS1115 @ 0x%02X:\n", ADS1115_ADDR);
  const uint8_t first = (requestedChannel <= 3) ? requestedChannel : 0;
  const uint8_t last = (requestedChannel <= 3) ? requestedChannel : 3;
  for (uint8_t channel = first; channel <= last; channel++) {
    int16_t counts = 0;
    float volts = 0.0f;
    if (readADS1115Channel(channel, counts, volts)) {
      if (channel == 3) {
        Serial.printf("  AIN%u (%s): %d counts, %.4f V\n", channel, adsChannelLabel(channel), counts, volts);
      } else {
        float resistanceOhms = 0.0f;
        float temperatureC = 0.0f;
        if (thermistorFromDividerVoltage(volts, resistanceOhms, temperatureC)) {
          Serial.printf("  AIN%u (%s): %d counts, %.4f V, %.0f ohm, %.1f C\n",
                        channel,
                        adsChannelLabel(channel),
                        counts,
                        volts,
                        resistanceOhms,
                        temperatureC);
        } else {
          Serial.printf("  AIN%u (%s): %d counts, %.4f V, %s\n",
                        channel,
                        adsChannelLabel(channel),
                        counts,
                        volts,
                        thermistorFaultHint(volts));
        }
      }
    } else {
      Serial.printf("  AIN%u (%s): read failed\n", channel, adsChannelLabel(channel));
    }
  }
}

void configureINA226(uint8_t address, const char *name) {
  if (writeI2CRegister16BE(I2C1, name, address, INA226_REG_CALIBRATION, INA226_CALIBRATION_VALUE)) {
    Serial.printf("%s calibrated: shunt=%.3f ohm current_lsb=%.3f mA/LSB calibration=0x%04X\n",
                  name,
                  INA226_SHUNT_OHMS,
                  INA226_CURRENT_LSB_A * 1000.0f,
                  INA226_CALIBRATION_VALUE);
  }
}

void configureAllINA226() {
  configureINA226(INA226_ADDR_1, "INA226-1/I2C1");
  configureINA226(INA226_ADDR_2, "INA226-2/I2C1");
}

void printINA226(uint8_t address, const char *name) {
  uint16_t manufacturer = 0;
  uint16_t die = 0;
  uint16_t config = 0;
  uint16_t calibration = 0;
  uint16_t busRaw = 0;
  uint16_t shuntRaw = 0;
  uint16_t currentRaw = 0;
  uint16_t powerRaw = 0;

  Serial.printf("%s (INA226 @ 0x%02X):\n", name, address);
  if (!readI2CRegister16BE(I2C1, name, address, INA226_REG_MANUFACTURER_ID, manufacturer) ||
      !readI2CRegister16BE(I2C1, name, address, INA226_REG_DIE_ID, die) ||
      !readI2CRegister16BE(I2C1, name, address, INA226_REG_CONFIG, config) ||
      !readI2CRegister16BE(I2C1, name, address, INA226_REG_CALIBRATION, calibration) ||
      !readI2CRegister16BE(I2C1, name, address, INA226_REG_BUS_VOLTAGE, busRaw) ||
      !readI2CRegister16BE(I2C1, name, address, INA226_REG_SHUNT_VOLTAGE, shuntRaw) ||
      !readI2CRegister16BE(I2C1, name, address, INA226_REG_CURRENT, currentRaw) ||
      !readI2CRegister16BE(I2C1, name, address, INA226_REG_POWER, powerRaw)) {
    Serial.println(F("  INA226 read failed."));
    return;
  }

  Serial.printf("  manufacturer=0x%04X (%s) die=0x%04X (%s)\n",
                manufacturer,
                (manufacturer == 0x5449) ? "TI" : "unexpected",
                die,
                (die == 0x2260) ? "INA226" : "unexpected");
  Serial.printf("  config=0x%04X calibration=0x%04X\n", config, calibration);
  Serial.printf("  bus=%.4f V shunt=%.3f mV\n",
                static_cast<float>(busRaw) * 1.25f / 1000.0f,
                static_cast<float>(static_cast<int16_t>(shuntRaw)) * 2.5f / 1000.0f);
  if (calibration == 0) {
    Serial.printf("  current_raw=%d power_raw=%u (calibration is 0, current/power raw only)\n",
                  static_cast<int16_t>(currentRaw),
                  powerRaw);
  } else {
    Serial.printf("  current=%.4f A power=%.4f W (raw current=%d raw power=%u)\n",
                  static_cast<float>(static_cast<int16_t>(currentRaw)) * INA226_CURRENT_LSB_A,
                  static_cast<float>(powerRaw) * INA226_CURRENT_LSB_A * 25.0f,
                  static_cast<int16_t>(currentRaw),
                  powerRaw);
  }
}

void printAllDevices() {
  printADS1115();
  printINA226(INA226_ADDR_1, "INA226-1/I2C1");
  printINA226(INA226_ADDR_2, "INA226-2/I2C1");
  printBQStatus(1);
  printBQStatus(2);
}

String commandToken(const String &command, uint8_t requestedIndex) {
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

String commandRemainderAfterTokens(const String &command, uint8_t tokenCount) {
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

void printStatus() {
  Serial.println(F("Status:"));
  Serial.printf("  Fan: %s\n", fanOn ? "ON" : "OFF");
  Serial.printf("  BQ1_CE: %s\n", bq1CeOn ? "ASSERTED / CHARGE ALLOWED" : "INACTIVE / CHARGE BLOCKED");
  Serial.printf("  BQ2_CE: %s\n", bq2CeOn ? "ASSERTED / CHARGE ALLOWED" : "INACTIVE / CHARGE BLOCKED");
  Serial.printf("  BQ1_INT GPIO%u: %s\n", PIN_BQ1_INT, digitalRead(PIN_BQ1_INT) ? "HIGH" : "LOW");
  Serial.printf("  BQ2_INT GPIO%u: %s\n", PIN_BQ2_INT, digitalRead(PIN_BQ2_INT) ? "HIGH" : "LOW");
  Serial.printf("  PWM1 GPIO%u duty: %u / 255\n", PIN_DCHG_PWM_CH1, pwm1Duty);
  Serial.printf("  PWM2 GPIO%u duty: %u / 255\n", PIN_DCHG_PWM_CH2, pwm2Duty);
  uint16_t cellVoltageMv = 0;
  if (readChannelCellVoltageMv(1, cellVoltageMv)) {
    Serial.printf("  Cell A / CH1 voltage: %u mV (%s)\n", cellVoltageMv, (cellVoltageMv >= CELL_PRESENT_MIN_MV) ? "cell detected" : "no/low cell");
  }
  if (readChannelCellVoltageMv(2, cellVoltageMv)) {
    Serial.printf("  Cell B / CH2 voltage: %u mV (%s)\n", cellVoltageMv, (cellVoltageMv >= CELL_PRESENT_MIN_MV) ? "cell detected" : "no/low cell");
  }
  if ((lastI2C1DeviceCount >= 0) && (lastI2C2DeviceCount >= 0)) {
    Serial.printf("  Last I2C scan: I2C1=%d device(s), I2C2=%d device(s)\n", lastI2C1DeviceCount, lastI2C2DeviceCount);
  } else {
    Serial.println(F("  Last I2C scan: not available; run scan"));
  }
  Serial.printf("  RS485 mode: %s\n", rs485TransmitMode ? "TRANSMIT" : "RECEIVE");
}

void rs485Send(const String &text) {
  if (text.length() == 0) {
    Serial.println(F("RS485 TX skipped: no text provided."));
    return;
  }

  Serial.printf("RS485 TX: %s\n", text.c_str());
  setRS485Mode(true);
  delay(2);
  RS485Serial.println(text);
  RS485Serial.flush();
  delay(2);
  setRS485Mode(false);
  Serial.println(F("RS485 returned to receive mode."));
}

void handleCommand(String command) {
  command.trim();
  if (command.length() == 0) {
    return;
  }

  String lower = command;
  lower.toLowerCase();

  if ((lower == F("h")) || (lower == F("help"))) {
    printHelp();
  } else if (lower == F("status")) {
    printStatus();
  } else if (lower == F("scan")) {
    lastI2C2DeviceCount = scanI2C2Software("I2C2");
    lastI2C1DeviceCount = scanI2CBus(I2C1, "I2C1");
  } else if (lower == F("scan1")) {
    lastI2C1DeviceCount = scanI2CBus(I2C1, "I2C1");
  } else if (lower == F("scan2")) {
    lastI2C2DeviceCount = scanI2C2Software("I2C2");
  } else if (lower == F("devices")) {
    printAllDevices();
  } else if (commandToken(lower, 0) == F("ads")) {
    uint8_t channel = 0xFF;
    const String channelToken = commandToken(lower, 1);
    if ((channelToken.length() > 0) && !parseNumberToken(channelToken, 3, channel)) {
      Serial.println(F("Invalid ADS1115 channel. Use: ads [0-3]"));
      return;
    }
    printADS1115(channel);
  } else if (lower == F("ina")) {
    printINA226(INA226_ADDR_1, "INA226-1/I2C1");
    printINA226(INA226_ADDR_2, "INA226-2/I2C1");
  } else if ((commandToken(lower, 0) == F("bq1")) || (commandToken(lower, 0) == F("bq2"))) {
    const uint8_t chargerNumber = (commandToken(lower, 0) == F("bq1")) ? 1 : 2;
    const String action = commandToken(lower, 1);
    const String state = commandToken(lower, 2);
    if (action.length() == 0) {
      printBQStatus(chargerNumber);
    } else if (action == F("safe")) {
      makeBQSafe(chargerNumber);
    } else if ((action == F("adc")) && ((state == F("on")) || (state == F("off")))) {
      setBQAdc(chargerNumber, state == F("on"));
    } else if (action == F("ichg")) {
      uint16_t currentMa = 0;
      if (!parseNumberToken16(state, BQ25622_ICHG_MIN_MA, BQ25622_ICHG_MAX_MA, currentMa)) {
        Serial.println(F("Invalid BQ charge current. Use: bq1 ichg <80-3000> or bq2 ichg <80-3000>; value must be an exact 80 mA step."));
        return;
      }
      setBQChargeCurrentLimit(chargerNumber, currentMa);
    } else if ((action == F("charge")) && ((state == F("on")) || (state == F("off")))) {
      setBQChargeEnable(chargerNumber, state == F("on"));
    } else if ((action == F("ce")) && ((state == F("on")) || (state == F("off")))) {
      const uint8_t cePin = (chargerNumber == 1) ? PIN_BQ1_CE : PIN_BQ2_CE;
      const char *ceName = (chargerNumber == 1) ? "BQ1" : "BQ2";
      setBQCE(cePin, state == F("on"), ceName); // true = LOW (active), false = HIGH (inactive)
      Serial.printf("Forced %s CE pin %s (charging remains %s in registers unless changed).\n", 
                    ceName, state == F("on") ? "LOW (active)" : "HIGH (inactive)", 
                    state == F("on") ? "disabled" : "disabled");
    } else if ((action == F("on")) || (action == F("off"))) {
      Serial.println(F("NOTE: use 'charge on/off'; applying guarded charge command."));
      setBQChargeEnable(chargerNumber, action == F("on"));
    } else {
      Serial.println(F("Invalid BQ command. Use: bq1|bq2, safe, adc on|off, ichg <mA>, charge on|off, or on|off."));
    }
  } else if (lower == F("fan on")) {
    setFanManualOverride(true);
    setFan(true);
  } else if (lower == F("fan off")) {
    setFanManualOverride(true);
    setFan(false);
  } else if (lower == F("fan auto")) {
    setFanManualOverride(false);
    Serial.println(F("Fan returned to automatic thermal control."));
  } else if (lower == F("int")) {
    Serial.printf("BQ1_INT GPIO%u: %s\n", PIN_BQ1_INT, digitalRead(PIN_BQ1_INT) ? "HIGH" : "LOW");
    Serial.printf("BQ2_INT GPIO%u: %s\n", PIN_BQ2_INT, digitalRead(PIN_BQ2_INT) ? "HIGH" : "LOW");
  } else if (lower == F("led r")) {
    setLedColor(255, 0, 0);
    Serial.println(F("LED: red"));
  } else if (lower == F("led g")) {
    setLedColor(0, 255, 0);
    Serial.println(F("LED: green"));
  } else if (lower == F("led b")) {
    setLedColor(0, 0, 255);
    Serial.println(F("LED: blue"));
  } else if (lower == F("led w")) {
    setLedColor(255, 255, 255);
    Serial.println(F("LED: white"));
  } else if (lower == F("led off")) {
    setLedColor(0, 0, 0);
    Serial.println(F("LED: off"));
  } else if (lower == F("alloff")) {
    setAllOutputsOff();
    makeBQSafe(1);
    makeBQSafe(2);
  } else if ((commandToken(lower, 0) == F("pwm1")) || (commandToken(lower, 0) == F("pwm2"))) {
    uint8_t duty = 0;
    const String pwmCommand = commandToken(lower, 0);
    const String dutyToken = commandToken(lower, 1);
    if (!parseNumberToken(dutyToken, 255, duty)) {
      Serial.println(F("Invalid PWM duty. Use: pwm1 <0-255> or pwm2 <0-255>"));
      return;
    }
    setPWMChannel((pwmCommand == F("pwm1")) ? 1 : 2, duty);
  } else if ((commandToken(lower, 0) == F("i2c")) && ((commandToken(lower, 1) == F("read1")) || (commandToken(lower, 1) == F("read2")))) {
    uint8_t address = 0;
    uint8_t reg = 0;
    if (!parseNumberToken(commandToken(lower, 2), 0x7F, address) || !parseNumberToken(commandToken(lower, 3), 0xFF, reg)) {
      Serial.println(F("Invalid I2C read. Use: i2c read1 <addr> <reg> or i2c read2 <addr> <reg>"));
      return;
    }

    uint8_t value = 0;
    if (commandToken(lower, 1) == F("read1")) {
      readI2CRegister(I2C1, "I2C1", address, reg, value);
    } else {
      readI2C2Software("I2C2", address, reg, value);
    }
  } else if ((commandToken(lower, 0) == F("i2c")) && ((commandToken(lower, 1) == F("write1")) || (commandToken(lower, 1) == F("write2")))) {
    uint8_t address = 0;
    uint8_t reg = 0;
    uint8_t value = 0;
    if (!parseNumberToken(commandToken(lower, 2), 0x7F, address) ||
        !parseNumberToken(commandToken(lower, 3), 0xFF, reg) ||
        !parseNumberToken(commandToken(lower, 4), 0xFF, value)) {
      Serial.println(F("Invalid I2C write. Use: i2c write1 <addr> <reg> <value> or i2c write2 <addr> <reg> <value>"));
      return;
    }

    if (commandToken(lower, 1) == F("write1")) {
      writeI2CRegister(I2C1, "I2C1", address, reg, value);
    } else {
      writeI2C2Software("I2C2", address, reg, value);
    }
  } else if ((commandToken(lower, 0) == F("rs485")) && (commandToken(lower, 1) == F("tx"))) {
    rs485Send(commandRemainderAfterTokens(command, 2));
  } else if (commandToken(lower, 0) == F("wifi")) {
    handleWifiSerialCommand(command);
  } else {
    Serial.printf("Unknown command: %s\n", command.c_str());
    Serial.println(F("Type help for commands."));
  }
}

void pollSerialCommand() {
  static String line;

  while (Serial.available() > 0) {
    const char c = static_cast<char>(Serial.read());
    if ((c == '\n') || (c == '\r')) {
      if (line.length() > 0) {
        handleCommand(line);
        line = "";
      }
    } else if (isPrintable(c)) {
      line += c;
      if (line.length() > 160) {
        Serial.println(F("Command too long; clearing input buffer."));
        line = "";
      }
    }
  }
}

void pollRS485() {
  while (RS485Serial.available() > 0) {
    const char c = static_cast<char>(RS485Serial.read());
    Serial.write(c);
  }
}

void setup() {
  // CRITICAL HARDWARE SAFETY:
  // Immediately force discharge PWM pins LOW. If these pins float or are pulled high
  // during the 3-second Serial wait, the RC filter on the op-amp charges up and
  // turns the discharge MOSFET fully ON, shorting the battery.
  // We must also configure the LEDC peripheral to hold the pin LOW actively.
  pinMode(PIN_DCHG_PWM_CH1, OUTPUT);
  digitalWrite(PIN_DCHG_PWM_CH1, LOW);
  pinMode(PIN_DCHG_PWM_CH2, OUTPUT);
  digitalWrite(PIN_DCHG_PWM_CH2, LOW);

  // Force the power-path outputs to safe states.
  pinMode(PIN_FAN_MOSFET, OUTPUT);
  digitalWrite(PIN_FAN_MOSFET, LOW);
  pinMode(PIN_BQ1_CE, OUTPUT);
  digitalWrite(PIN_BQ1_CE, !BQ_CE_ACTIVE_LEVEL);
  pinMode(PIN_BQ2_CE, OUTPUT);
  digitalWrite(PIN_BQ2_CE, !BQ_CE_ACTIVE_LEVEL);
  pinMode(PIN_RS485_RE_DE, OUTPUT);
  digitalWrite(PIN_RS485_RE_DE, LOW);
  pinMode(PIN_WS2812, OUTPUT);
  digitalWrite(PIN_WS2812, LOW);
  statusLed.begin();
  statusLed.setBrightness(STATUS_LED_BRIGHTNESS);
  statusLed.clear();
  statusLed.show();

  // Initialize PWM peripherals to 0 duty cycle immediately
  setupPwm(PIN_DCHG_PWM_CH1, PWM_CHANNEL_1);
  setupPwm(PIN_DCHG_PWM_CH2, PWM_CHANNEL_2);
  writePwm(PIN_DCHG_PWM_CH1, PWM_CHANNEL_1, 0);
  writePwm(PIN_DCHG_PWM_CH2, PWM_CHANNEL_2, 0);

  // Start USB serial FIRST. Reconfiguring GPIO before the USB-CDC serial is up
  // was crashing the board before any output appeared; bringing serial up first
  // matches the bring-up order proven to boot cleanly.
  Serial.begin(SERIAL_BAUD);
  const uint32_t serialStartMs = millis();
  while (!Serial && ((millis() - serialStartMs) < 3000)) {
    delay(10);
  }
  Serial.printf("Reset reason: %s\n", resetReasonLabel());
  gBootSessionId = esp_random();
  const String resetReason = resetReasonToString(esp_reset_reason());
  strncpy(gBootResetReason, resetReason.c_str(), sizeof(gBootResetReason) - 1);
  gBootResetReason[sizeof(gBootResetReason) - 1] = '\0';

  gI2cMutex = xSemaphoreCreateRecursiveMutex();

  pinMode(PIN_BQ1_INT, INPUT_PULLUP);
  pinMode(PIN_BQ2_INT, INPUT_PULLUP);

  I2C1.begin(PIN_I2C1_SDA, PIN_I2C1_SCL, I2C_CLOCK_HZ);
  sw2Init();
  Serial.printf("I2C1 started (hardware): SDA GPIO%u, SCL GPIO%u, %u Hz\n", PIN_I2C1_SDA, PIN_I2C1_SCL, I2C_CLOCK_HZ);
  Serial.printf("I2C2 started (software): SDA GPIO%u, SCL GPIO%u, ~100000 Hz\n", PIN_I2C2_SDA, PIN_I2C2_SCL);

  setAllOutputsOff();
  printBanner();

  RS485Serial.begin(RS485_BAUD, SERIAL_8N1, PIN_RS485_RX, PIN_RS485_TX);
  setRS485Mode(false);
  Serial.printf("RS485 UART started: RX GPIO%u, TX GPIO%u, RE_DE GPIO%u, %u baud, receive mode\n",
                PIN_RS485_RX,
                PIN_RS485_TX,
                PIN_RS485_RE_DE,
                RS485_BAUD);

  lastI2C2DeviceCount = scanI2C2Software("I2C2");
  lastI2C1DeviceCount = scanI2CBus(I2C1, "I2C1");

  initializeBatteryChemistry();
  Serial.println(F("Putting both BQ25622 chargers in safe host-controlled mode and enabling ADC readback..."));
  makeBQSafe(1);
  makeBQSafe(2);
  configureAllINA226();
  delay(80);

  uint8_t bqPartInfo = 0;
  uint16_t peripheralRegister = 0;
  const bool bq1Ready = bqReadByte(1, BQ25622_REG_PART_INFORMATION, bqPartInfo);
  const bool bq2Ready = bqReadByte(2, BQ25622_REG_PART_INFORMATION, bqPartInfo);
  const bool ina1Ready = readI2CRegister16BE(
      I2C1, "INA226-1/I2C1", INA226_ADDR_1, INA226_REG_CONFIG, peripheralRegister);
  const bool ina2Ready = readI2CRegister16BE(
      I2C1, "INA226-2/I2C1", INA226_ADDR_2, INA226_REG_CONFIG, peripheralRegister);
  const bool adsReady = readI2CRegister16BE(
      I2C1, "ADS1115/I2C1", ADS1115_ADDR, ADS1115_REG_CONFIG, peripheralRegister);
  gBootInitializationFault =
      (gI2cMutex == nullptr) || !bq1Ready || !bq2Ready || !ina1Ready || !ina2Ready || !adsReady;
  if (gBootInitializationFault) {
    Serial.println(F("BOOT FAULT: one or more required I2C devices failed validation."));
  }

  printAllDevices();

  Serial.println(F("Setup complete. Outputs remain off unless changed by serial command."));
  printHelp();
  wifiApiInit();
  gBootInitializationComplete = true;
}

void loop() {
  static uint32_t loopCount = 0;
  if (loopCount < 20) {
    DBG_CHK_PRINTF("[CHK] loop %u: before pollSerialCommand\n", loopCount);
  }
  pollSerialCommand();
  if (loopCount < 20) {
    DBG_CHK_PRINTF("[CHK] loop %u: before pollRS485\n", loopCount);
  }
  pollRS485();
  if (loopCount < 20) {
    DBG_CHK_PRINTF("[CHK] loop %u: before wifiApiLoop\n", loopCount);
  }
  wifiApiLoop();
  tickStatusLed();
  yield();
  if (loopCount < 20) {
    DBG_CHK_PRINTF("[CHK] loop %u: end\n", loopCount);
    loopCount++;
  }
}
