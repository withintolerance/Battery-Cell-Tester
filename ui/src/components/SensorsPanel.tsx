"use client";

import type { InaStatus, StatusResponse, ThermistorStatus } from "@/lib/types";

function Metric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 font-mono text-sm text-white">{value}</p>
    </div>
  );
}

export function SensorsPanel({ status }: { status: StatusResponse }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-2xl border border-slate-700 bg-slate-900/80 p-5">
        <h3 className="mb-4 text-base font-semibold text-white">INA226</h3>
        <div className="space-y-4">
          {status.ina.map((ina: InaStatus) => (
            <div key={ina.label} className="rounded-xl border border-slate-800 p-4">
              <p className="mb-3 text-sm font-medium text-slate-300">
                {ina.label} ({ina.address})
              </p>
              {ina.valid ? (
                <div className="grid grid-cols-2 gap-3">
                  <Metric label="Bus" value={`${ina.busVolts.toFixed(4)} V`} />
                  <Metric
                    label="Shunt"
                    value={`${ina.shuntMilliVolts.toFixed(3)} mV`}
                  />
                  <Metric
                    label="Current"
                    value={`${ina.currentAmps.toFixed(4)} A`}
                  />
                  <Metric
                    label="Power"
                    value={`${ina.powerWatts.toFixed(4)} W`}
                  />
                </div>
              ) : (
                <p className="text-sm text-rose-300">Read failed</p>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-700 bg-slate-900/80 p-5">
        <h3 className="mb-4 text-base font-semibold text-white">Thermistors</h3>
        <div className="space-y-3">
          {status.thermistors.map((therm: ThermistorStatus) => (
            <div
              key={therm.adsChannel}
              className="flex items-center justify-between rounded-xl border border-slate-800 px-4 py-3"
            >
              <div>
                <p className="text-sm font-medium text-white">{therm.label}</p>
                <p className="text-xs text-slate-500">ADS AIN{therm.adsChannel}</p>
              </div>
              <div className="text-right">
                {therm.valid ? (
                  <>
                    <p className="font-mono text-sm text-white">
                      {therm.temperatureC.toFixed(1)} °C
                    </p>
                    <p className="text-xs text-slate-400">
                      {therm.resistanceOhms.toFixed(0)} Ω
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-rose-300">Invalid</p>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
