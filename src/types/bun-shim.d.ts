// Minimal ambient `Bun` declaration.
// A few maintenance scripts under src/scripts/* are invoked via `bun run` and
// use the Bun global directly. They never execute inside the Next.js runtime,
// but `next build` type-checks every .ts under src/, so without this shim the
// production build fails on `Cannot find name 'Bun'`. Keep it minimal — only
// the surface those scripts touch.

declare const Bun: {
  spawn(
    cmd: string[],
    opts?: {
      stdin?: 'pipe' | 'inherit' | 'ignore' | number;
      stdout?: 'pipe' | 'inherit' | 'ignore' | number;
      stderr?: 'pipe' | 'inherit' | 'ignore' | number;
      cwd?: string;
      env?: Record<string, string | undefined>;
    }
  ): {
    stdin: { write(input: string | Uint8Array): void; end(): void; flush?(): void };
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    kill(): void;
  };
  file(path: string): {
    text(): Promise<string>;
    json<T = unknown>(): Promise<T>;
    arrayBuffer(): Promise<ArrayBuffer>;
    exists(): Promise<boolean>;
  };
  write(path: string, data: string | Uint8Array | Blob): Promise<number>;
};
