export interface DoctorReadiness {
  readonly node24InUse: boolean;
  readonly directories: Readonly<Record<string, boolean>>;
  readonly openAiConfigured: boolean;
  readonly bankCredentialsConfigured: boolean;
}

export function isDoctorReady(report: DoctorReadiness): boolean {
  return (
    report.node24InUse &&
    Object.values(report.directories).every(Boolean) &&
    report.openAiConfigured &&
    report.bankCredentialsConfigured
  );
}
