import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BASE_DIR, SOCKET_PATH } from "./paths";

export type BrokerResponse =
  | { type: "response"; id: number; ok: true; data: unknown }
  | { type: "response"; id: number; ok: false; error: string };

export interface BrokerClientOptions {
  socketPath?: string;
  role?: string;
  sessionId?: string;
  pid?: number;
  autoStart?: boolean;
}

function createJsonLineParser(onMessage: (msg: unknown) => void): (chunk: Buffer) => void {
  let buffer = "";
  return (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    while (true) {
      const index = buffer.indexOf("\n");
      if (index === -1) return;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        // ignore invalid lines
      }
    }
  };
}

function writeJsonLine(socket: net.Socket, msg: unknown): void {
  socket.write(`${JSON.stringify(msg)}\n`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class BrokerClient {
  private readonly socketPath: string;
  private readonly role: string;
  private readonly sessionId: string;
  private readonly pid: number;
  private readonly autoStart: boolean;
  private socket: net.Socket | null = null;
  private requestId = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(options: BrokerClientOptions = {}) {
    this.socketPath = options.socketPath ?? process.env.IRIS_BROKER_SOCK ?? SOCKET_PATH;
    this.role = options.role ?? "client";
    this.sessionId = options.sessionId ?? randomUUID();
    this.pid = options.pid ?? process.pid;
    this.autoStart = options.autoStart ?? this.socketPath === SOCKET_PATH;
  }

  async request(op: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const socket = await this.ensureSocket();
    const id = ++this.requestId;

    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      writeJsonLine(socket, { type: "request", id, sessionId: this.sessionId, op, ...args });
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error("Timed out waiting for broker response"));
      }, 60000);
    });
  }

  async close(): Promise<void> {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      socket.once("close", finish);
      socket.end();
      setTimeout(() => {
        socket.destroy();
        finish();
      }, 250).unref?.();
    });
  }

  private async ensureSocket(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) return this.socket;

    try {
      this.socket = await this.connect();
    } catch {
      if (this.autoStart) this.maybeStartBroker();
      for (let i = 0; i < 20 && (!this.socket || this.socket.destroyed); i += 1) {
        await sleep(100);
        try {
          this.socket = await this.connect();
          break;
        } catch {
          // retry
        }
      }
    }

    if (!this.socket || this.socket.destroyed) {
      throw new Error(
        `Could not connect to local broker at ${this.socketPath}. Run \`iris install\` and ensure the extension is loaded.`
      );
    }

    this.socket.setNoDelay(true);
    this.socket.on(
      "data",
      createJsonLineParser((msg) => {
        if (!msg || typeof msg !== "object") return;
        const response = msg as Partial<BrokerResponse> & { id?: number; type?: string };
        if (response.type !== "response" || typeof response.id !== "number") return;
        const pending = this.pending.get(response.id);
        if (!pending) return;
        this.pending.delete(response.id);
        if (response.ok) pending.resolve(response.data);
        else pending.reject(new Error(response.error ?? "Unknown broker error"));
      })
    );
    this.socket.on("close", () => {
      this.socket = null;
    });
    this.socket.on("error", () => {
      this.socket = null;
    });

    writeJsonLine(this.socket, { type: "hello", role: this.role, sessionId: this.sessionId, pid: this.pid });

    return this.socket;
  }

  private async connect(): Promise<net.Socket> {
    return await new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      socket.once("connect", () => resolve(socket));
      socket.once("error", (error) => reject(error));
    });
  }

  private maybeStartBroker(): void {
    const brokerPath = join(BASE_DIR, "broker.cjs");
    if (!existsSync(brokerPath)) return;
    try {
      const child = spawn(process.execPath, [brokerPath], { detached: true, stdio: "ignore" });
      child.unref();
    } catch {
      // ignore spawn failures
    }
  }
}

export function createBrokerClient(options: BrokerClientOptions = {}): BrokerClient {
  return new BrokerClient(options);
}
