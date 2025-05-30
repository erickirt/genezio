import { detectPythonCommand } from "../../utils/detectPythonCommand.js";

export enum Language {
    js = "js",
    ts = "ts",
    swift = "swift",
    python = "python",
    pythonAsgi = "python-asgi",
    dart = "dart",
    kt = "kt",
    go = "go",
    container = "container",
}

export enum AuthenticationDatabaseType {
    mongo = "mongodb",
    postgres = "postgresql",
}

export enum DatabaseType {
    neon = "postgres-neon",
    mongo = "mongo-atlas",
}

export enum TriggerType {
    jsonrpc = "jsonrpc",
    cron = "cron",
    http = "http",
}

export enum AuthenticationEmailTemplateType {
    verification = "VERIFICATION",
    passwordReset = "PASS_RESET",
}

export enum FunctionType {
    aws = "aws",
    httpServer = "httpServer",
    persistent = "persistent",
}

export enum InstanceSize {
    tiny = "tiny",
    medium = "medium",
    large = "large",
}

export const entryFileFunctionMap = {
    js: "index.mjs",
    ts: "index.mjs",
    python: "index.py",
    go: "main.go",
};

export const startingCommandMap = {
    js: "node",
    ts: "node",
    python: await detectPythonCommand(),
    go: "go",
};
