# STATE

Simulation lab unchanged: kernel, eight safety bugs, soundness spot-check, shrink, replay links.

Live execution layer: in-page Raft and register adapters, plus an external disk process (`targets/kv-server.mjs`) that Faultline does not implement. The connector talks to that process over HTTP, crashes it, and checks the replies and the file the new process reloads.

Engine tests run from `npm test` and `npm run test:faultline`, including the external process. GitHub Actions builds, typechecks, runs those tests, and drives Hunt, Live, and External disk in a browser.

Open: no etcd, Postgres, or production-cluster adapter. Do not point this at a system you cannot throw away.
