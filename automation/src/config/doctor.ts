export interface DoctorReadiness {
  readonly node24InUse: boolean;
  readonly directories: Readonly<Record<string, boolean>>;
  readonly openAiConfigured: boolean;
  readonly bankCredentialsConfigured: boolean;
}

export type DoctorMode = 'replay' | 'discovery';

export function isDoctorReady(report: DoctorReadiness, mode: DoctorMode = 'replay'): boolean {
  return (
    report.node24InUse &&
    Object.values(report.directories).every(Boolean) &&
    (mode === 'replay' || report.openAiConfigured) &&
    report.bankCredentialsConfigured
  );
}
