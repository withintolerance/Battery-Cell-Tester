#include "tester_shared.h"

#include <Arduino.h>
#include <math.h>
#include <string.h>

#if !ENABLE_SERIAL_OUTPUT
#define Serial gNullSerial
#endif

static AutomationChannelState gAuto1 = {AutoState::IDLE, 0, 0, 0.0f, 0, 0, "", 0};
static AutomationChannelState gAuto2 = {AutoState::IDLE, 0, 0, 0.0f, 0, 0, "", 0};

static constexpr uint32_t REST_DURATION_MS = 5 * 60 * 1000;
static constexpr uint32_t STORAGE_CHARGE_DURATION_MS = 10 * 60 * 1000;
static constexpr float TARGET_DISCHARGE_AMPS = 2.5f;
static constexpr float DISCHARGE_CURRENT_TOLERANCE_AMPS = 0.05f;
static constexpr float DISCHARGE_OVERCURRENT_AMPS = 3.0f;

static constexpr float PID_KP = 35.0f;
static constexpr float PID_KI = 4.0f;
static constexpr float PID_KD = 0.0f;
static constexpr float PID_INTEGRAL_LIMIT = 20.0f;
static constexpr uint8_t DISCHARGE_PWM_STEP_LIMIT_NEAR_TARGET = 8;
static constexpr uint8_t DISCHARGE_PWM_STEP_LIMIT_FAR_FROM_TARGET = 32;
static constexpr uint8_t DISCHARGE_PWM_STEP_LIMIT_OVERSHOOT = 40;

struct PidState {
  float integral;
  float prevError;
  float currentOffsetAmps;
  float previousCapacityCurrentAmps;
  bool hasPreviousCapacityCurrent;
};

static PidState gPid1 = {0.0f, 0.0f, 0.0f, 0.0f, false};
static PidState gPid2 = {0.0f, 0.0f, 0.0f, 0.0f, false};
static bool gChargerHardwareFault = false;

extern uint8_t pwm1Duty;
extern uint8_t pwm2Duty;

static bool isRecoverableAutoState(AutoState state) {
  return (state == AutoState::CHARGE_INITIAL) ||
         (state == AutoState::REST) ||
         (state == AutoState::DISCHARGE) ||
         (state == AutoState::CHARGE_STORAGE);
}

static bool autoStateFromString(const char *stateName, AutoState &state) {
  if (strcmp(stateName, "CHARGE_INITIAL") == 0) {
    state = AutoState::CHARGE_INITIAL;
    return true;
  }
  if (strcmp(stateName, "REST") == 0) {
    state = AutoState::REST;
    return true;
  }
  if (strcmp(stateName, "DISCHARGE") == 0) {
    state = AutoState::DISCHARGE;
    return true;
  }
  if (strcmp(stateName, "CHARGE_STORAGE") == 0) {
    state = AutoState::CHARGE_STORAGE;
    return true;
  }
  if (strcmp(stateName, "IDLE") == 0) {
    state = AutoState::IDLE;
    return true;
  }
  if (strcmp(stateName, "COMPLETE") == 0) {
    state = AutoState::COMPLETE;
    return true;
  }
  if (strcmp(stateName, "FAULT") == 0) {
    state = AutoState::FAULT;
    return true;
  }
  return false;
}

static float clampFinite(float value, float fallback, float minValue, float maxValue) {
  if (!isfinite(value)) {
    return fallback;
  }
  if (value < minValue) {
    return minValue;
  }
  if (value > maxValue) {
    return maxValue;
  }
  return value;
}

static void setFault(uint8_t channel, AutomationChannelState &state, const char *reason);

static uint8_t dischargeDutyForChannel(uint8_t channel) {
  return (channel == 1) ? pwm1Duty : pwm2Duty;
}

static void resetPidState(PidState &pid) {
  pid.integral = 0.0f;
  pid.prevError = 0.0f;
  pid.currentOffsetAmps = 0.0f;
  pid.previousCapacityCurrentAmps = 0.0f;
  pid.hasPreviousCapacityCurrent = false;
}

static float correctedDischargeCurrentAmps(const PidState &pid, const InaReading &ina) {
  return fabsf(ina.currentAmps - pid.currentOffsetAmps);
}

static bool inaBusVoltageMv(const InaReading &ina, uint16_t &voltageMv) {
  if (!ina.valid || !isfinite(ina.busVolts) || ina.busVolts < 0.0f || ina.busVolts > 65.535f) {
    return false;
  }
  voltageMv = static_cast<uint16_t>(lroundf(ina.busVolts * 1000.0f));
  return true;
}

static void captureDischargeCurrentOffset(uint8_t channel, PidState &pid, const InaReading &ina) {
  pid.currentOffsetAmps = ina.valid ? ina.currentAmps : 0.0f;
  pid.previousCapacityCurrentAmps = 0.0f;
  pid.hasPreviousCapacityCurrent = true;
  Serial.printf("Auto CH%u: INA zero offset for discharge: %.4f A\n", channel, pid.currentOffsetAmps);
}

static void integrateDischargeCapacity(AutomationChannelState &state, PidState &pid, float currentAmps, float dt) {
  if (!pid.hasPreviousCapacityCurrent) {
    pid.previousCapacityCurrentAmps = currentAmps;
    pid.hasPreviousCapacityCurrent = true;
    return;
  }

  const float averageCurrentAmps = (pid.previousCapacityCurrentAmps + currentAmps) * 0.5f;
  state.capacityMah += averageCurrentAmps * (dt / 3600.0f) * 1000.0f;
  pid.previousCapacityCurrentAmps = currentAmps;
}

static uint8_t nextDischargeDuty(uint8_t channel, PidState &pid, float currentAmps, float dt) {
  const int currentDuty = dischargeDutyForChannel(channel);
  const float error = TARGET_DISCHARGE_AMPS - currentAmps;

  if (fabsf(error) <= DISCHARGE_CURRENT_TOLERANCE_AMPS) {
    pid.prevError = error;
    return static_cast<uint8_t>(currentDuty);
  }

  pid.integral += error * dt;
  pid.integral = clampFinite(pid.integral, 0.0f, -PID_INTEGRAL_LIMIT, PID_INTEGRAL_LIMIT);

  const float derivative = (dt > 0.0f) ? ((error - pid.prevError) / dt) : 0.0f;
  pid.prevError = error;

  int delta = static_cast<int>((PID_KP * error) + (PID_KI * pid.integral) + (PID_KD * derivative));
  if (error > 0.0f && delta < 1) {
    delta = 1;
  } else if (error < 0.0f && delta > -1) {
    delta = -1;
  }

  const uint8_t stepLimit = (error < 0.0f)
      ? DISCHARGE_PWM_STEP_LIMIT_OVERSHOOT
      : ((fabsf(error) > 0.5f) ? DISCHARGE_PWM_STEP_LIMIT_FAR_FROM_TARGET : DISCHARGE_PWM_STEP_LIMIT_NEAR_TARGET);
  if (delta > stepLimit) {
    delta = stepLimit;
  } else if (delta < -static_cast<int>(stepLimit)) {
    delta = -static_cast<int>(stepLimit);
  }

  const int nextDuty = currentDuty + delta;
  if (nextDuty <= 0) {
    return 0;
  }
  if (nextDuty >= 255) {
    return 255;
  }
  return static_cast<uint8_t>(nextDuty);
}

static void setFault(uint8_t channel, AutomationChannelState &state, const char *reason) {
  state.state = AutoState::FAULT;
  state.stateStartMs = millis();
  state.lastTickMs = state.stateStartMs;
  strncpy(state.faultReason, reason, sizeof(state.faultReason) - 1);
  state.faultReason[sizeof(state.faultReason) - 1] = '\0';
  
  trySetBQChargeEnable(channel, false);
  trySetPWMChannel(channel, 0);
  Serial.printf("Auto CH%u FAULT: %s\n", channel, reason);
}

void startAutomation(uint8_t channel, uint32_t cellId) {
  const CellChemistryProfile &profile = batteryChemistryProfile();
  AutomationChannelState &state = (channel == 1) ? gAuto1 : gAuto2;
  state.state = AutoState::CHARGE_INITIAL;
  state.stateStartMs = millis();
  state.lastTickMs = millis();
  state.capacityMah = 0.0f;
  state.restingVoltageMv = 0;
  state.activeVoltageMv = 0;
  state.faultReason[0] = '\0';
  state.cellId = cellId;

  resetPidState((channel == 1) ? gPid1 : gPid2);

  setBQChargeCurrentLimit(channel, profile.chargeCurrentMa);
  trySetBQChargeEnable(channel, true);
  Serial.printf("Auto CH%u STARTED (Cell %u, %s)\n", channel, cellId, profile.label);
}

void stopAutomation(uint8_t channel) {
  AutomationChannelState &state = (channel == 1) ? gAuto1 : gAuto2;
  state.state = AutoState::IDLE;
  trySetBQChargeEnable(channel, false);
  trySetPWMChannel(channel, 0);
  Serial.printf("Auto CH%u STOPPED\n", channel);
}

bool restoreAutomationFromServer(uint8_t channel,
                                 const char *stateName,
                                 uint32_t stateElapsedMs,
                                 float capacityMah,
                                 uint16_t restingVoltageMv,
                                 uint16_t activeVoltageMv,
                                 uint32_t cellId,
                                 uint8_t dischargeDuty) {
  if ((channel != 1) && (channel != 2)) {
    return false;
  }

  AutoState restoredState = AutoState::IDLE;
  if (!autoStateFromString(stateName, restoredState) || !isRecoverableAutoState(restoredState)) {
    Serial.printf("Auto CH%u recovery rejected: invalid state '%s'\n", channel, stateName);
    return false;
  }

  const CellChemistryProfile &profile = batteryChemistryProfile();
  AutomationChannelState &state = (channel == 1) ? gAuto1 : gAuto2;
  PidState &pid = (channel == 1) ? gPid1 : gPid2;
  const uint32_t now = millis();

  const bool safeOff = trySetBQChargeEnable(channel, false) && trySetPWMChannel(channel, 0);
  if (!safeOff) {
    setFault(channel, state, "Recovery failed: cannot force safe-off");
    return false;
  }

  state.state = restoredState;
  state.stateStartMs = (stateElapsedMs > now) ? 0 : (now - stateElapsedMs);
  state.lastTickMs = now;
  state.capacityMah = clampFinite(capacityMah, 0.0f, 0.0f, 100000.0f);
  state.restingVoltageMv = restingVoltageMv;
  state.activeVoltageMv = activeVoltageMv;
  state.cellId = cellId;
  state.faultReason[0] = '\0';

  resetPidState(pid);

  bool applied = false;
  switch (restoredState) {
    case AutoState::CHARGE_INITIAL:
      applied = setBQChargeCurrentLimit(channel, profile.chargeCurrentMa) &&
                trySetBQChargeEnable(channel, true);
      break;
    case AutoState::REST:
      applied = true;
      break;
    case AutoState::DISCHARGE:
      applied = trySetPWMChannel(channel, dischargeDuty);
      break;
    case AutoState::CHARGE_STORAGE:
      applied = setBQChargeCurrentLimit(channel, profile.storageChargeCurrentMa) &&
                trySetBQChargeEnable(channel, true);
      break;
    case AutoState::IDLE:
    case AutoState::COMPLETE:
    case AutoState::FAULT:
      applied = false;
      break;
  }

  if (!applied) {
    setFault(channel, state, "Recovery failed safety checks");
    return false;
  }

  Serial.printf("Auto CH%u RECOVERED from server: %s (Cell %u, elapsed %u ms)\n",
                channel,
                stateName,
                static_cast<unsigned>(state.cellId),
                static_cast<unsigned>(stateElapsedMs));
  return true;
}

static void tickChannel(uint8_t channel, AutomationChannelState &state, PidState &pid, const BqChannelReading &bq, const InaReading &ina, const ThermistorReading &therm) {
  const CellChemistryProfile &profile = batteryChemistryProfile();
  if (state.state == AutoState::IDLE) {
    return;
  }

  uint32_t now = millis();
  float dt = (now - state.lastTickMs) / 1000.0f;
  if (dt <= 0.0f) dt = 0.001f;
  state.lastTickMs = now;

  // Thermal Protection
  if (therm.valid && therm.temperatureC >= 40.0f) {
    setFault(channel, state, "Cell Over-temp (>=40C)");
    return;
  }
  if (bq.valid && bq.tdieApproxC > 80) {
    // Thermal throttle for charger
    if (state.state == AutoState::CHARGE_INITIAL || state.state == AutoState::CHARGE_STORAGE) {
      if (bq.chargeEnabled) {
        Serial.printf("Auto CH%u: BQ TDIE %dC > 80C, pausing charge\n", channel, bq.tdieApproxC);
        trySetBQChargeEnable(channel, false);
      }
      return; // Skip state logic until cooled
    }
  } else if (bq.valid && bq.tdieApproxC < 70) {
    // Resume charging if it was paused
    if ((state.state == AutoState::CHARGE_INITIAL || state.state == AutoState::CHARGE_STORAGE) && !bq.chargeEnabled) {
      Serial.printf("Auto CH%u: BQ TDIE %dC < 70C, resuming charge\n", channel, bq.tdieApproxC);
      trySetBQChargeEnable(channel, true);
    }
  }

  switch (state.state) {
    case AutoState::CHARGE_INITIAL: {
      bool isTerminated = bq.valid && bq.chargeEnabled && strcmp(bq.chgStatusText, "not charging / terminated") == 0;

      if (isTerminated) {
        // Charge complete
        trySetBQChargeEnable(channel, false);
        state.state = AutoState::REST;
        state.stateStartMs = now;
        Serial.printf("Auto CH%u: CHARGE_INITIAL complete (Terminated), resting...\n", channel);
      }
      break;
    }

    case AutoState::REST:
      if (now - state.stateStartMs >= REST_DURATION_MS) {
        uint16_t inaVoltageMv = 0;
        if (!inaBusVoltageMv(ina, inaVoltageMv)) {
          setFault(channel, state, "INA voltage unavailable after rest");
          return;
        }
        state.restingVoltageMv = inaVoltageMv;
        captureDischargeCurrentOffset(channel, pid, ina);
        state.state = AutoState::DISCHARGE;
        state.stateStartMs = now;
        Serial.printf("Auto CH%u: REST complete (V=%u mV), starting discharge...\n", channel, state.restingVoltageMv);
      }
      break;

    case AutoState::DISCHARGE: {
      uint32_t elapsedDischargeMs = now - state.stateStartMs;

      uint16_t inaVoltageMv = 0;
      if (!inaBusVoltageMv(ina, inaVoltageMv)) {
        setFault(channel, state, "INA voltage unavailable during discharge");
        return;
      }

      // Record active voltage exactly 5 minutes into discharge to measure sag
      if (state.activeVoltageMv == 0 && elapsedDischargeMs >= (5UL * 60UL * 1000UL)) {
        state.activeVoltageMv = inaVoltageMv;
        Serial.printf("Auto CH%u: Recorded active voltage at 5m: %u mV\n", 
                      channel, state.activeVoltageMv);
      }

      const float currentAmps = correctedDischargeCurrentAmps(pid, ina);
      integrateDischargeCapacity(state, pid, currentAmps, dt);

      if (currentAmps > DISCHARGE_OVERCURRENT_AMPS) {
        setFault(channel, state, "Discharge over-current (>3A)");
        return;
      }

      if (inaVoltageMv <= profile.dischargeCutoffMv) {
        trySetPWMChannel(channel, 0);
        state.state = AutoState::CHARGE_STORAGE;
        state.stateStartMs = now;
        setBQChargeCurrentLimit(channel, profile.storageChargeCurrentMa);
        trySetBQChargeEnable(channel, true);
        Serial.printf("Auto CH%u: DISCHARGE complete at INA %u mV (Cap=%.1f mAh), starting storage charge...\n",
                      channel, inaVoltageMv, state.capacityMah);
        break;
      }

      const uint8_t pwm = nextDischargeDuty(channel, pid, currentAmps, dt);
      if (pwm != dischargeDutyForChannel(channel)) {
        trySetPWMChannel(channel, pwm);
      }
      break;
    }

    case AutoState::CHARGE_STORAGE:
      if (now - state.stateStartMs >= STORAGE_CHARGE_DURATION_MS) {
        trySetBQChargeEnable(channel, false);
        state.state = AutoState::COMPLETE;
        state.stateStartMs = now;
        Serial.printf("Auto CH%u: STORAGE_CHARGE complete, cycle finished.\n", channel);
      }
      break;

    case AutoState::COMPLETE:
    case AutoState::FAULT:
    case AutoState::IDLE:
      break;
  }
}

extern bool fanOn;
extern void setFan(bool on);

static bool gFanManualOverride = false;

void setFanManualOverride(bool override) {
  gFanManualOverride = override;
}

bool automationIsIdle() {
  return gAuto1.state == AutoState::IDLE && gAuto2.state == AutoState::IDLE;
}

bool automationHasActiveChannel() {
  const auto isActive = [](AutoState state) {
    return state != AutoState::IDLE && state != AutoState::COMPLETE && state != AutoState::FAULT;
  };
  return isActive(gAuto1.state) || isActive(gAuto2.state);
}

bool automationHasCompleteChannel() {
  return gAuto1.state == AutoState::COMPLETE || gAuto2.state == AutoState::COMPLETE;
}

bool automationHasFault() {
  return gAuto1.state == AutoState::FAULT ||
         gAuto2.state == AutoState::FAULT ||
         gChargerHardwareFault;
}

static void tickThermalAndLed(const SystemSnapshot &snapshot) {
  // Heatsink Fan Control
  if (snapshot.thermHeatsink.valid && !gFanManualOverride) {
    if (snapshot.thermHeatsink.temperatureC > 40.0f && !fanOn) {
      setFan(true);
    } else if (snapshot.thermHeatsink.temperatureC < 35.0f && fanOn) {
      setFan(false);
    }

    // Heatsink Throttle
    if (snapshot.thermHeatsink.temperatureC > 60.0f) {
      if (gAuto1.state == AutoState::DISCHARGE) {
        trySetPWMChannel(1, 0);
        Serial.println("Auto CH1: Heatsink > 60C, throttling discharge");
      }
      if (gAuto2.state == AutoState::DISCHARGE) {
        trySetPWMChannel(2, 0);
        Serial.println("Auto CH2: Heatsink > 60C, throttling discharge");
      }
    }
  }

}

// BQ25622 REG0x1F: bits 7/6/5/3 are hard faults; bits 2:0 are TS zone status (often non-zero
// with no BQ TS thermistor wired — e.g. 0x06 = TS_PREWARM). Do not treat TS zone as a board fault.
static constexpr uint8_t BQ25622_HARD_FAULT_MASK = 0xE8;

static bool bqHasHardFault(const BqChannelReading &channel) {
  return channel.valid && ((channel.fault0 & BQ25622_HARD_FAULT_MASK) != 0);
}

void tickAutomation(SystemSnapshot &snapshot) {
  gChargerHardwareFault = bqHasHardFault(snapshot.channel1) || bqHasHardFault(snapshot.channel2);

  tickChannel(1, gAuto1, gPid1, snapshot.channel1, snapshot.ina1, snapshot.thermCellA);
  tickChannel(2, gAuto2, gPid2, snapshot.channel2, snapshot.ina2, snapshot.thermCellB);

  snapshot.auto1 = gAuto1;
  snapshot.auto2 = gAuto2;

  tickThermalAndLed(snapshot);
}
