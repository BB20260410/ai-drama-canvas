# Third-Party Notices

This file records third-party projects evaluated for the Novel Mode V1 work. It is an attribution and engineering provenance record, not legal advice.

## Current P0 status

As of 2026-07-31, the locked upstream implementations listed below have been audited but have **not yet been copied into this repository's Novel Mode implementation**. The license texts are checked in before the first possible code port so later source-level adoption cannot bypass attribution review.

The exact commits, Git tree IDs, source-file SHA-256 values, planned local targets, and modification intent are recorded in `docs/third-party/novel-donors.json`. When a later change copies or adapts upstream implementation, that record must be updated from `containsUpstreamImplementation: false`, and each affected local file must retain traceable provenance. Apache-2.0-derived files must carry a prominent notice that they were changed.

## CharacterArc

- Project: CharacterArc
- Repository: https://github.com/uu201/character-arc
- Locked commit: `c0fabfc743a9a3f3aa12af9add9d3208bd13d871`
- Locked tree: `fbe1c3ad4bbc89e2923beff713114e139afe5ab0`
- License: MIT
- Upstream license SHA-256: `d53e396570581aeda22c0dfd6a9fb12cf6c69a99814161668b2a104ee6cddf9f`
- Local license copy: `licenses/MIT-CharacterArc.txt`
- Copyright notice: Copyright (c) 2025 zhouyeshan

The locked tree contains `LICENSE` and no separate `NOTICE` file.

Planned engineering use is limited to selected state normalization, checkpoint/backfill, context-budget, staged-change, and Diff-review concepts. SQLite authority, target-less latest-state queries, current-only relationships, plaintext credentials, branding, screenshots, and example content are not adopted.

## OpenFic

- Project: OpenFic
- Repository: https://github.com/syrizelink/OpenFic
- Locked commit: `90f26c16a764c941124a3e70c8b2693b32a5f1d9`
- Locked tree: `bb402904075474d74a30c71c559ee2c123ade45f`
- License: Apache License 2.0
- Upstream license SHA-256: `58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd`
- Local license copy: `licenses/Apache-2.0-OpenFic.txt`

The locked tree contains identical `LICENSE` and `backend/LICENSE` files and no separate `NOTICE` file.
The upstream license file has no terminal line feed. The local text appends one terminal LF only; its local SHA-256 is `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30` and its length is 11,358 bytes. All legal text is otherwise byte-identical.

Planned engineering use is limited to selected layered-context, summary-invalidation, deterministic chunking/retrieval, revision, and Diff-preview concepts, reimplemented in the existing TypeScript/Electron/node:sqlite architecture. The Python/FastAPI/LanceDB/LangGraph stack, database authority, branding, screenshots, and example content are not adopted.

## Explicit no-copy references

InkOS is AGPL-3.0 and may be used only as a behavioral specification reference. Its source must not be copied, translated line by line, linked, or introduced as a dependency into this application without a separate explicit licensing decision.

51mazi is not a core donor. Its unsafe Electron, monolithic storage, and untested persistence patterns are excluded from Novel Mode.

## Distribution gate

Before source or packaged distribution of Novel Mode, the release process must:

1. reconcile every adopted local file with `docs/third-party/novel-donors.json`;
2. include the applicable full license texts and this notice in packaged resources;
3. preserve applicable copyright, patent, trademark, and attribution notices;
4. mark modified Apache-2.0-derived files prominently;
5. generate and inspect an SBOM and dependency-license report;
6. verify that no excluded AGPL implementation, logo, trademark asset, screenshot, or example novel is present.
