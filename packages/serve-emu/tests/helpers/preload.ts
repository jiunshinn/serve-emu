import { afterEach } from "bun:test";
import { stopHarnesses } from "./server-harness.ts";

// A preload hook runs after every test in every file; one registered inside
// server-harness.ts would only run in the first file that imports it.
afterEach(stopHarnesses);
