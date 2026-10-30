import { applyTestEnv } from "./env";

// Unit tests don't touch the database, but modules read env at import time.
applyTestEnv();
