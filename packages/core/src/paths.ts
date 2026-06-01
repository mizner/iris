import { homedir } from "os";
import { join } from "path";

export const BASE_DIR = join(homedir(), ".iris");
export const SOCKET_PATH = join(BASE_DIR, "broker.sock");
export const NATIVE_HOST_NAME = "com.iris.host";
