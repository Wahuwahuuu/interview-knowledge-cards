export type DesktopUpdateStatus = {
  version: string;
  phase: 'disabled' | 'idle' | 'checking' | 'downloading' | 'ready' | 'installing' | 'error';
  availableVersion?: string;
  progress?: number;
  checkedAt?: string;
  message: string;
};

/** Only exposed to an authenticated administrator on the computer's loopback service. */
export type DesktopUpdateService = {
  status(): DesktopUpdateStatus;
  check(): void;
  install(): void;
};
