# STATE

Simulation lab unchanged: kernel, eight safety bugs, soundness spot-check, shrink, replay links.

Live execution layer: adapters for a Raft service and a single-node register. The runner injects faults and checks only replies and status pages. Engine tests run from `npm test` and `npm run test:faultline`. GitHub Actions builds, typechecks, runs those tests, and drives the production preview in a browser.

Open: no remote cluster adapter yet. P2 multi-system platform is not claimed.
