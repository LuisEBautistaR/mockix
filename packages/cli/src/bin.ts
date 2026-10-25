#!/usr/bin/env node
import { main } from "./main.js";

const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());

const code = await main(process.argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l) }, stop.signal);
process.exitCode = code;
