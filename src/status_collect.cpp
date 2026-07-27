#include "tester_shared.h"

#include <Wire.h>
#include <math.h>

extern bool fanOn;
extern bool bq1CeOn;
extern bool bq2CeOn;
extern bool rs485TransmitMode;
extern int lastI2C1DeviceCount;
extern int lastI2C2DeviceCount;
extern uint8_t pwm1Duty;
extern uint8_t pwm2Duty;

extern TwoWire &I2C1;

extern bool readADS1115Channel(uint8_t channel, int16_t &counts, float &volts);
extern bool thermistorFromDividerVoltage(float volts, float &resistanceOhms, float &temperatureC);
extern bool readI2CRegister16BE(TwoWire &bus, const char *busName, uint8_t address, uint8_t reg, uint16_t &value);
extern bool bqReadByte(uint8_t chargerNumber, uint8_t reg, uint8_t &value);
extern bool bqRead16LE(uint8_t chargerNumber, uint8_t reg, uint16_t &value);
extern const char *bqChargeStatusToString(uint8_t status);
extern const char *bqVbusStatusToString(uint8_t status);

static constexpr uint8_t INA226_ADDR_1 = 0x40;
static constexpr uint8_t INA226_ADDR_2 = 0x41;
static constexpr uint8_t INA226_REG_BUS_VOLTAGE = 0x02;
static constexpr uint8_t INA226_REG_SHUNT_VOLTAGE = 0x01;
static constexpr uint8_t INA226_REG_CURRENT = 0x04;
static constexpr uint8_t INA226_REG_POWER = 0x03;
static constexpr uint8_t INA226_REG_CALIBRATION = 0x05;
static constexpr float INA226_CURRENT_LSB_A = 0.000125f;

static constexpr uint8_t BQ25622_REG_CHARGER_CONTROL_1 = 0x16;
static constexpr uint8_t BQ25622_REG_CHARGER_STATUS_1 = 0x1E;
static constexpr uint8_t BQ25622_REG_FAULT_STATUS_0 = 0x1F;
static constexpr uint8_t BQ25622_REG_IBUS_ADC = 0x28;
static constexpr uint8_t BQ25622_REG_IBAT_ADC = 0x2A;
static constexpr uint8_t BQ25622_REG_VBUS_ADC = 0x2C;
static constexpr uint8_t BQ25622_REG_VPMID_ADC = 0x2E;
static constexpr uint8_t BQ25622_REG_VBAT_ADC = 0x30;
static constexpr uint8_t BQ25622_REG_VSYS_ADC = 0x32;
static constexpr uint8_t BQ25622_REG_TDIE_ADC = 0x36;
static constexpr uint8_t BQ25622_CONTROL1_EN_CHG = 0x20;

char gLastActionError[160] = "";

static bool isInstalledThermistorChannel(uint8_t adsChannel) {
  return adsChannel <= 2;
}

static void collectThermistor(uint8_t adsChannel, const char *label, ThermistorReading &out) {
  out.adsChannel = adsChannel;
  out.label = label;
  out.valid = false;
  out.counts = 0;
  out.volts = 0.0f;
  out.resistanceOhms = 0.0f;
  out.temperatureC = 0.0f;

  if (!readADS1115Channel(adsChannel, out.counts, out.volts)) {
    return;
  }

  if (!isInstalledThermistorChannel(adsChannel)) {
    return;
  }

  float ohms = 0.0f;
  float tempC = 0.0f;
  if (thermistorFromDividerVoltage(out.volts, ohms, tempC)) {
    out.valid = true;
    out.resistanceOhms = ohms;
    out.temperatureC = tempC;
  }
}

static void collectIna(uint8_t address, const char *label, InaReading &out) {
  out.address = address;
  out.label = label;
  out.valid = false;
  out.busVolts = 0.0f;
  out.shuntMilliVolts = 0.0f;
  out.currentAmps = 0.0f;
  out.powerWatts = 0.0f;

  uint16_t calibration = 0;
  uint16_t busRaw = 0;
  uint16_t shuntRaw = 0;
  uint16_t currentRaw = 0;
  uint16_t powerRaw = 0;
  if (!readI2CRegister16BE(I2C1, label, address, INA226_REG_CALIBRATION, calibration) ||
      !readI2CRegister16BE(I2C1, label, address, INA226_REG_BUS_VOLTAGE, busRaw) ||
      !readI2CRegister16BE(I2C1, label, address, INA226_REG_SHUNT_VOLTAGE, shuntRaw) ||
      !readI2CRegister16BE(I2C1, label, address, INA226_REG_CURRENT, currentRaw) ||
      !readI2CRegister16BE(I2C1, label, address, INA226_REG_POWER, powerRaw)) {
    return;
  }

  out.valid = true;
  out.busVolts = static_cast<float>(busRaw) * 1.25f / 1000.0f;
  out.shuntMilliVolts = static_cast<float>(static_cast<int16_t>(shuntRaw)) * 2.5f / 1000.0f;
  if (calibration != 0) {
    out.currentAmps = static_cast<float>(static_cast<int16_t>(currentRaw)) * INA226_CURRENT_LSB_A;
    out.powerWatts = static_cast<float>(powerRaw) * INA226_CURRENT_LSB_A * 25.0f;
  }
}

static void collectBqChannel(uint8_t channel, const char *label, BqChannelReading &out) {
  out.channel = channel;
  out.label = label;
  out.valid = false;
  out.cellVoltageMv = 0;
  out.cellPresent = false;
  out.chargeEnabled = (channel == 1) ? bq1CeOn : bq2CeOn;
  out.dischargeDuty = (channel == 1) ? pwm1Duty : pwm2Duty;
  out.ichgLimitMa = 0;
  out.control1 = 0;
  out.status1 = 0;
  out.fault0 = 0;
  out.chgStatusText = "unknown";
  out.vbusStatusText = "unknown";
  out.ibusMa = 0;
  out.ibatMa = 0;
  out.vbusMv = 0;
  out.vpmidMv = 0;
  out.vbatMv = 0;
  out.vsysMv = 0;
  out.tdieApproxC = 0;

  if (readChannelCellVoltageMv(channel, out.cellVoltageMv)) {
    // Cell presence and safety checks use the Kelvin-sensed INA226 bus voltage.
    // Keep the lower threshold for the UI so deeply discharged cells are still visible.
    out.cellPresent = out.cellVoltageMv >= 500;
  }
  bqReadChargeCurrentLimitMa(channel, out.ichgLimitMa);

  uint8_t control1 = 0;
  uint8_t status1 = 0;
  uint8_t fault0 = 0;
  if (!bqReadByte(channel, BQ25622_REG_CHARGER_CONTROL_1, control1) ||
      !bqReadByte(channel, BQ25622_REG_CHARGER_STATUS_1, status1) ||
      !bqReadByte(channel, BQ25622_REG_FAULT_STATUS_0, fault0)) {
    return;
  }

  out.valid = true;
  out.control1 = control1;
  out.status1 = status1;
  out.fault0 = fault0;
  out.chargeEnabled = ((control1 & BQ25622_CONTROL1_EN_CHG) != 0) && out.chargeEnabled;
  out.chgStatusText = bqChargeStatusToString((status1 >> 3) & 0x03);
  out.vbusStatusText = bqVbusStatusToString(status1 & 0x07);

  uint16_t raw = 0;
  if (bqRead16LE(channel, BQ25622_REG_IBUS_ADC, raw)) {
    out.ibusMa = static_cast<int16_t>(raw);
  }
  if (bqRead16LE(channel, BQ25622_REG_IBAT_ADC, raw)) {
    out.ibatMa = static_cast<int16_t>(raw);
  }
  if (bqRead16LE(channel, BQ25622_REG_VBUS_ADC, raw)) {
    out.vbusMv = static_cast<uint16_t>(((raw >> 2) & 0x1FFF) * 397UL / 100UL);
  }
  if (bqRead16LE(channel, BQ25622_REG_VPMID_ADC, raw)) {
    out.vpmidMv = static_cast<uint16_t>(((raw >> 2) & 0x1FFF) * 397UL / 100UL);
  }
  if (bqRead16LE(channel, BQ25622_REG_VBAT_ADC, raw)) {
    out.vbatMv = static_cast<uint16_t>(((raw >> 1) & 0x0FFF) * 199UL / 100UL);
  }
  if (bqRead16LE(channel, BQ25622_REG_VSYS_ADC, raw)) {
    out.vsysMv = static_cast<uint16_t>(((raw >> 1) & 0x0FFF) * 199UL / 100UL);
  }
  if (bqRead16LE(channel, BQ25622_REG_TDIE_ADC, raw)) {
    // TDIE_ADC is a 12-bit 2's complement value, stored in bits [11:0] of the 16-bit register.
    // The bit step is 0.5°C.
    int16_t signedRaw = static_cast<int16_t>(raw << 4) >> 4; // Sign-extend 12 bits to 16 bits
    out.tdieApproxC = signedRaw / 2;
  }
}

void collectSystemSnapshot(SystemSnapshot &snapshot) {
  snapshot.fanOn = fanOn;
  snapshot.rs485TransmitMode = rs485TransmitMode;
  snapshot.bootId = firmwareBootId();
  snapshot.uptimeMs = millis();
  strncpy(snapshot.resetReason, firmwareResetReason(), sizeof(snapshot.resetReason) - 1);
  snapshot.resetReason[sizeof(snapshot.resetReason) - 1] = '\0';
  snapshot.i2c1DeviceCount = lastI2C1DeviceCount;
  snapshot.i2c2DeviceCount = lastI2C2DeviceCount;

  wifiGetSnapshotInfo(snapshot.wifiConnected, snapshot.wifiSsid, sizeof(snapshot.wifiSsid), snapshot.wifiIp,
                    sizeof(snapshot.wifiIp), snapshot.wifiStatus, sizeof(snapshot.wifiStatus));

  collectBqChannel(1, "Cell A", snapshot.channel1);
  yield();
  collectBqChannel(2, "Cell B", snapshot.channel2);
  yield();
  collectIna(INA226_ADDR_1, "INA226-1", snapshot.ina1);
  yield();
  collectIna(INA226_ADDR_2, "INA226-2", snapshot.ina2);
  yield();
  collectThermistor(0, "Cell B", snapshot.thermCellB);
  yield();
  collectThermistor(1, "Heatsink", snapshot.thermHeatsink);
  yield();
  collectThermistor(2, "Cell A", snapshot.thermCellA);
  yield();
  collectThermistor(3, "NC", snapshot.thermNc);
}

static uint8_t gSnapshotTickStep = 0;

void resetSnapshotCollection() {
  gSnapshotTickStep = 0;
}

bool snapshotCollectionIdle() {
  return gSnapshotTickStep == 0;
}

bool tickSnapshotCollection(SystemSnapshot &snapshot) {
  DBG_CHK_PRINTF("[CHK] tickSnapshotCollection: step %u\n", gSnapshotTickStep);
  switch (gSnapshotTickStep) {
    case 0:
      DBG_CHK_PRINTLN(F("[CHK] tickSnapshotCollection: meta"));
      snapshot.fanOn = fanOn;
      snapshot.rs485TransmitMode = rs485TransmitMode;
      snapshot.bootId = firmwareBootId();
      snapshot.uptimeMs = millis();
      strncpy(snapshot.resetReason, firmwareResetReason(), sizeof(snapshot.resetReason) - 1);
      snapshot.resetReason[sizeof(snapshot.resetReason) - 1] = '\0';
      snapshot.i2c1DeviceCount = lastI2C1DeviceCount;
      snapshot.i2c2DeviceCount = lastI2C2DeviceCount;
      wifiGetSnapshotInfo(snapshot.wifiConnected, snapshot.wifiSsid, sizeof(snapshot.wifiSsid), snapshot.wifiIp,
                          sizeof(snapshot.wifiIp), snapshot.wifiStatus, sizeof(snapshot.wifiStatus));
      gSnapshotTickStep++;
      return false;
    case 1:
      DBG_CHK_PRINTLN(F("[CHK] tickSnapshotCollection: BQ1"));
      collectBqChannel(1, "Cell A", snapshot.channel1);
      gSnapshotTickStep++;
      return false;
    case 2:
      DBG_CHK_PRINTLN(F("[CHK] tickSnapshotCollection: BQ2"));
      collectBqChannel(2, "Cell B", snapshot.channel2);
      gSnapshotTickStep++;
      return false;
    case 3:
      DBG_CHK_PRINTLN(F("[CHK] tickSnapshotCollection: INA1"));
      collectIna(INA226_ADDR_1, "INA226-1", snapshot.ina1);
      gSnapshotTickStep++;
      return false;
    case 4:
      DBG_CHK_PRINTLN(F("[CHK] tickSnapshotCollection: INA2"));
      collectIna(INA226_ADDR_2, "INA226-2", snapshot.ina2);
      gSnapshotTickStep++;
      return false;
    case 5:
      DBG_CHK_PRINTLN(F("[CHK] tickSnapshotCollection: therm 0"));
      collectThermistor(0, "Cell B", snapshot.thermCellB);
      gSnapshotTickStep++;
      return false;
    case 6:
      DBG_CHK_PRINTLN(F("[CHK] tickSnapshotCollection: therm 1"));
      collectThermistor(1, "Heatsink", snapshot.thermHeatsink);
      gSnapshotTickStep++;
      return false;
    case 7:
      DBG_CHK_PRINTLN(F("[CHK] tickSnapshotCollection: therm 2"));
      collectThermistor(2, "Cell A", snapshot.thermCellA);
      gSnapshotTickStep++;
      return false;
    case 8:
      DBG_CHK_PRINTLN(F("[CHK] tickSnapshotCollection: therm 3"));
      collectThermistor(3, "NC", snapshot.thermNc);
      gSnapshotTickStep = 0;
      return true;
    default:
      gSnapshotTickStep = 0;
      return false;
  }
}
