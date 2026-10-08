export interface DevServer {
  pid: number;
  /** Puertos en escucha, ordenados de menor a mayor. */
  ports: number[];
  processName: string;
  framework: string;
  /** Nombre de la carpeta del proyecto, o null si no se pudo deducir. */
  project: string | null;
  projectPath: string | null;
  commandLine: string;
  /** Epoch ms en que arrancó el proceso, o null si no se conoce. */
  startedAt: number | null;
  /** Escucha en 0.0.0.0 / :: (visible desde otros equipos de la red). */
  exposed: boolean;
  /** Fila de Docker: un grupo de contenedores (o todo Docker si no se pudo preguntar a Docker). */
  docker: boolean;
  /** Contenedores del grupo. Sin esto, la fila de Docker es solo informativa. */
  containers?: { id: string; name: string }[];
  /** Memoria del servidor y sus procesos hijos, en bytes. */
  memoryBytes: number;
  /** % de CPU desde la búsqueda anterior; null en la primera búsqueda. */
  cpuPercent: number | null;
  /** Lleva prendido más tiempo del límite configurado. */
  forgotten: boolean;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}

export interface ScanResult {
  servers: DevServer[];
  scannedAt: number;
  error?: string;
}

export type KillResult = ActionResult;

export interface Api {
  list(): Promise<ScanResult>;
  kill(pid: number): Promise<KillResult>;
  killAll(): Promise<KillResult>;
  open(port: number): Promise<void>;
  copyUrl(port: number): Promise<ActionResult>;
  openFolder(pid: number): Promise<ActionResult>;
  openEditor(pid: number): Promise<ActionResult>;
  restart(pid: number): Promise<ActionResult>;
  onUpdate(cb: (result: ScanResult) => void): void;
}
