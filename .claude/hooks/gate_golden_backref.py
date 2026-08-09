#!/usr/bin/env python3
r"""골든 역참조 게이트 — `status: done` 골든이 자신이 주장하는 대로 검증됐는지 본다.

## 왜 만드는가 (원장 28e·28g)

`harness/evals/golden/track-a-product.jsonl`의 `status: done` 골든은 `verify`
필드로 자신을 검증하는 테스트 파일(또는 스크립트)을 가리킨다. 이 필드는 두 가지를
암묵적으로 주장한다 — ① 그 경로가 실재한다 ② 그 파일이 실제로 이 GA를 검증한다.
둘 다 **아무 게이트도 확인하지 않았다.**

실제로 일어난 일: GA-52의 `verify`가 **존재하지 않는 파일**을 가리켰는데
`status: done`이라 "검증됨"으로 읽혔다 — CI는 계속 초록이었다. 다음 라운드
후보를 조사하던 중 **우연히** 발견됐다(의도적 감사가 아니었다). 원장 28e는
"처리했다는 보고가 검증 없이 나간다"는 같은 형태의 드리프트가 **다섯 번째**
반복된 사례로 이 건을 기록한다 — 사람 주의력이 이 계열에서 계속 진다.
`gate_spec_mirror.py`(원장 26af)가 "문서가 인용한 **수치**가 정본과 어긋난다"를
자동화했듯, 이 게이트는 "골든이 **자기 자신의 검증 존재**를 정확히 주장하는가"를
자동화한다.

## 이 게이트가 하는 일 (원장 28g, team-lead 지시)

  - **A-①** `status: done`인 골든의 `verify` 경로가 실재하는가 → **하드 실패**
    (`--check`가 exit 1). 오탐이 원리적으로 없다 — 파일은 있거나 없거나 둘 중
    하나다.
  - **A-②** 그 파일(들)이 자기 GA-ID를 본문에 포함하는가(역참조) → **경고만**
    (exit 0 유지). "관례"이지 절대 규칙이 아니다 — 실측 92%(70/76)만 지킨다.

## 실측으로 확정한 세부 규칙 (골든 전수 조사, 코드를 안 읽고는 알 수 없던 것들)

  - **`verify`는 콤마로 여러 경로를 나열할 수 있다**(실측 7건: GA-11·17·41·
    42·43·57·58). 콤마 뒤 공백 유무가 섞여 있다(`"a,b"`·`"a, b"` 둘 다 있다) —
    트리밍한다.
  - **A-①(경로 실재)은 나열된 경로 전부가 실재해야 통과한다** — 하나라도
    없으면 하드 실패.
  - **A-②(역참조)는 ANY 의미론이다(ALL이 아니다)** — GA-17·GA-57은 나열된 두
    경로 중 정확히 하나에만 자기 ID가 있는데, 리뷰어가 이미 "관례를 지키는
    70건"에 이 둘을 포함해 셌다. ALL을 요구하면 이미 준수 중인 두 건에 새
    오탐이 생겨 리뷰어 실측과 이 게이트의 판정이 어긋난다.
  - **`verify`가 테스트 파일만 가리키지 않는다** — GA-41·42·43은
    `scripts/smoke-deploy.sh`(스모크 스크립트)를 가리킨다. 두 검사 모두
    확장자·디렉터리로 대상을 좁히지 않는다.
  - **하드 실패가 경고보다 우선한다** — 경로 중 하나라도 없으면 그 항목의
    역참조 검사 자체를 시도하지 않는다(열 수 없는 파일의 "내용"을 판정하는
    것은 무의미하다).

## 무엇을 보지 않는가 (`gate_spec_mirror.py`의 동명 절과 같은 원칙)

  - **`status: todo` 골든** — 애초에 미검증이라 대조 대상이 아니다(스펙 미러
    게이트와 동일 원칙 — "todo는 아직 확정되지 않은 초안이라 정합성을 요구할
    대상이 아니다").
  - **`track-b-harness.jsonl`(프로세스 골든)** — 스키마 자체가 `{id, type,
    task, expected_behavior, rubric, judge, status}`라 `verify` 필드가 없다.
    별도 예외 분기를 두지 않는다 — "entry에 `verify` 키가 없으면 스킵"이라는
    계약 하나가 트랙 B 전체를 자동으로 포함한다. 오늘 존재하는 골든에서
    `_workspace/`(gitignore 대상)를 가리키는 `verify`는 0건이다 — 그런 사례가
    생기면 일반 경로와 동일하게 취급하는 것이 지금 시점의 판단이다(별도 제외
    규칙을 만들 근거가 아직 없다).
  - **`verify`가 빈 문자열("")인 경우** — 실 데이터에 0건이라 필드 부재와
    동일하게(스킵) 취급한다. 하드 실패로 볼지는 실제 사례가 생기면 재논의한다
    (스코프 크리프 방지).
  - **A-②(경고)는 절대 exit 1을 내지 않는다** — "관례일 뿐"이라는 근거(실측
    92% 준수)를 하드 규칙으로 승격하지 않는다. 경고가 실패로 바뀌면 소음
    게이트가 되어 꺼진다(`gate_spec_mirror.py`가 문서 인용 오탐을 exit 1로
    만들지 않은 것과 같은 정신).
  - **JSONL 파싱 오류 처리** — `gate_spec_mirror.py`의 `check_constant_mirrors`가
    이미 그 형태를 다루므로 이 게이트는 조용히 건너뛴다(스코프 밖).

## API

    def check_entry(entry: dict, root: Path = ROOT) -> tuple[list[str], list[str]]:
        '''entry: JSONL 한 줄을 파싱한 dict. 반환: (hard_fails, warnings) —
        사람이 읽는 사유 문자열 리스트. entry에 `verify` 키가 없거나
        status != "done"이면 둘 다 빈 리스트(검사 대상이 아니다).'''

`root`가 기본값을 갖는 이유는 `gate_spec_mirror.read_constants(path=CONSTANTS)`와
같다 — 실사용은 저장소 루트를, `--selftest`는 임시 디렉터리를 격리해 넘긴다.

## 배선 — 이 게이트는 두 층으로 검증된다

  1. **`--selftest`**(이 파일, coder 작성) — 합성 fixture로 게이트 로직 자체가
     고장 나지 않았는지 본다. `check.sh`·CI 양쪽에서 돈다.
  2. **`tests/gates/test_golden_backref_gate.py`**(test-writer 작성, pytest) —
     `check_entry`를 직접 호출해 계약(다중 경로·ANY 의미론·트리밍 등)과 **실
     저장소 골든 데이터**(하드 실패 0건, 경고 정확히 6건)를 검증한다.

두 층으로 나누는 이유는 검증 격리(CLAUDE.md 최상위 규칙 — 작업한 세션이
자기 산출물의 합격 여부를 스스로 판정하지 않는다)를 이 게이트에도 지키기
위해서다: `--selftest`는 구현자(coder)가 쓰고, pytest는 별도 세션
(test-writer)이 쓴다. `--selftest`만으로는 "test-writer가 실측으로 확정한
세부 규칙"(다중 경로 ANY 의미론 등)이 구현자 자신의 이해로만 고정돼 같은
맹점을 공유할 위험이 있다 — pytest가 독립적으로 그 계약을 대조한다.

실행 모드
---------
  --check          전 대상 검사. 하드 실패가 있으면 exit 1, 경고만 있으면 exit 0.
  --selftest       내장 검증. 게이트 자체가 고장 났는지 확인한다.

PreToolUse 훅으로는 두지 않는다 — 골든을 `todo`→`done`으로 바꾸는 편집 중에는
`verify`가 아직 안 채워졌거나 파일이 아직 커밋 전일 수 있다(스펙 미러 게이트와
동일한 이유로 훅으로 막으면 정상 작업 흐름이 막힌다).
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
GOLDEN_DIR = ROOT / "harness" / "evals" / "golden"


def _force_utf8() -> None:
    """stdout·stderr를 UTF-8로 고정 — Windows 한국어 로케일(cp949)에서 한글·
    em-dash(—)를 그대로 출력하면 UnicodeEncodeError로 죽는다(원장 26r blocker
    B4, 기존 게이트 전부가 쓰는 방어를 그대로 가져온다)."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, OSError):
            pass


def _stderr(msg: str) -> None:
    _force_utf8()
    print(msg, file=sys.stderr)


def check_entry(entry: dict, root: Path = ROOT) -> tuple[list[str], list[str]]:
    """`entry` 하나(JSONL 한 줄)를 판정한다.

    반환: (hard_fails, warnings) — 각각 사람이 읽는 사유 문자열 리스트.
    `entry`에 `verify` 키가 없거나(트랙 B 스키마) `status != "done"`이면 둘 다
    빈 리스트다(검사 대상이 아니다, 위 "무엇을 보지 않는가" 참고).
    """
    if entry.get("status") != "done" or "verify" not in entry:
        return [], []

    verify = entry.get("verify")
    entry_id = str(entry.get("id", ""))
    if not isinstance(verify, str) or not verify.strip():
        # 빈 verify(실 데이터 0건) — 필드 부재와 동일하게 스킵한다(위 docblock
        # "무엇을 보지 않는가" 참고, coder 판단으로 남긴 결정).
        return [], []

    paths = [p.strip() for p in verify.split(",") if p.strip()]

    hard_fails: list[str] = []
    for rel in paths:
        if not (root / rel).exists():
            hard_fails.append("%s: verify 경로가 존재하지 않는다 — %s" % (entry_id, rel))
    if hard_fails:
        # 경로 중 하나라도 없으면 역참조 검사 자체를 시도하지 않는다 — 열 수
        # 없는 파일의 "내용"을 판정하는 것은 무의미하고, 하드 실패가 이미
        # `--check`를 exit 1로 만들므로 경고를 더할 이유가 없다.
        return hard_fails, []

    # A-② 역참조 — ANY 의미론(나열된 파일 중 하나라도 자기 ID를 포함하면
    # 경고하지 않는다, GA-17·GA-57 실측 근거는 위 docblock 참고).
    any_contains_id = False
    for rel in paths:
        try:
            text = (root / rel).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue  # 읽을 수 없는 파일은 역참조가 없는 것으로 취급(존재는 이미 확인됐다)
        if entry_id and entry_id in text:
            any_contains_id = True
            break

    warnings: list[str] = []
    if not any_contains_id:
        warnings.append(
            "%s: verify 파일 중 자기 GA-ID를 본문에 포함한 파일이 없다(관례 위반, "
            "하드 실패 아님) — %s" % (entry_id, ", ".join(paths))
        )
    return [], warnings


def _iter_golden_entries() -> list[tuple[str, int, dict]]:
    """`(파일명, 줄 번호, dict)` — 골든 디렉터리 전체(JSON 파싱 실패는 조용히
    건너뛴다, 위 docblock "무엇을 보지 않는가" 참고 — 이 게이트의 스코프 밖)."""
    out: list[tuple[str, int, dict]] = []
    for jsonl in sorted(GOLDEN_DIR.glob("*.jsonl")):
        for lineno, raw in enumerate(jsonl.read_text(encoding="utf-8").splitlines(), 1):
            raw = raw.strip()
            if not raw:
                continue
            try:
                rec = json.loads(raw)
            except json.JSONDecodeError:
                continue
            out.append((jsonl.name, lineno, rec))
    return out


def run_check() -> int:
    hard_total: list[str] = []
    warn_total: list[str] = []
    for fname, lineno, rec in _iter_golden_entries():
        hard, warn = check_entry(rec)
        hard_total += ["  %s:%d %s" % (fname, lineno, m) for m in hard]
        warn_total += ["  %s:%d %s" % (fname, lineno, m) for m in warn]

    if warn_total:
        print(
            "[골든 역참조 게이트] 경고 %d건(exit 0 유지, 관례 위반이지 하드 규칙 "
            "위반이 아니다):\n%s" % (len(warn_total), "\n".join(warn_total))
        )

    if hard_total:
        _stderr(
            "[골든 역참조 게이트] 하드 실패 %d건 — status: done인 골든의 verify 경로가 "
            "존재하지 않는다:\n%s\n"
            "verify는 실재하는 파일을 가리켜야 한다(원장 28e·28g — GA-52가 이 형태로 "
            "조용히 검증 없이 done 처리됐던 사례)." % (len(hard_total), "\n".join(hard_total))
        )
        return 1

    print("[골든 역참조 게이트] 하드 실패 0건 (경고 %d건)." % len(warn_total))
    return 0


def run_selftest() -> int:
    """게이트 자체의 검증. `check_entry`가 `root`를 인자로 받으므로(선례:
    `gate_spec_mirror.read_constants(path=CONSTANTS)`) 저장소 실 파일을
    만들거나 지울 필요 없이 임시 디렉터리 하나로 전부 격리한다."""
    failed: list[str] = []

    with tempfile.TemporaryDirectory() as d:
        root = Path(d).resolve()
        unit_dir = root / "tests" / "unit"
        unit_dir.mkdir(parents=True)
        (unit_dir / "clean.test.ts").write_text("// GA-S1 self-reference\n", encoding="utf-8")
        (unit_dir / "no-id.test.ts").write_text("// no self id in here\n", encoding="utf-8")

        must_block = [
            (
                "done + verify 경로 부재 -> 하드 실패",
                {"id": "GA-S2", "status": "done", "verify": "tests/unit/missing.test.ts"},
            ),
        ]
        for name, entry in must_block:
            hard, _warn = check_entry(entry, root=root)
            if not hard:
                failed.append("차단 실패 — %s" % name)

        must_pass = [
            (
                "done + 경로 실재 + ID 포함 -> 완전 통과(경고 없음)",
                {"id": "GA-S1", "status": "done", "verify": "tests/unit/clean.test.ts"},
                0,
                0,
            ),
            (
                "done + 경로 실재 + ID 없음 -> 경고만(하드 실패 아님)",
                {"id": "GA-S3", "status": "done", "verify": "tests/unit/no-id.test.ts"},
                0,
                1,
            ),
            (
                "status: todo -> 경로가 없어도 검사 대상이 아니다",
                {"id": "GA-S4", "status": "todo", "verify": "tests/unit/missing.test.ts"},
                0,
                0,
            ),
            (
                "verify 필드 없음(트랙 B 실제 스키마) -> 스킵",
                {"id": "GB-S1", "type": "process", "status": "todo"},
                0,
                0,
            ),
            (
                "verify 빈 문자열 -> 필드 부재와 동일하게 스킵",
                {"id": "GA-S6", "status": "done", "verify": ""},
                0,
                0,
            ),
            (
                "다중 경로: 하나만 ID 포함해도 경고 없음(ANY 의미론, GA-17·GA-57 실측)"
                " — clean.test.ts가 GA-S1을 담고 있으므로 이 항목의 id도 GA-S1이다",
                {"id": "GA-S1", "status": "done",
                 "verify": "tests/unit/no-id.test.ts, tests/unit/clean.test.ts"},
                0,
                0,
            ),
        ]
        for name, entry, want_hard, want_warn in must_pass:
            hard, warn = check_entry(entry, root=root)
            if len(hard) != want_hard or len(warn) != want_warn:
                failed.append(
                    "오탐/미탐 — %s: hard=%d(기대 %d) warn=%d(기대 %d)"
                    % (name, len(hard), want_hard, len(warn), want_warn)
                )

        # 다중 경로: 하나라도 없으면 하드 실패(전부 실재해야 통과).
        multi_missing = {
            "id": "GA-S7", "status": "done",
            "verify": "tests/unit/clean.test.ts,tests/unit/missing2.test.ts",
        }
        hard, warn = check_entry(multi_missing, root=root)
        if not hard or warn:
            failed.append("다중 경로 부분 부재 — 하나라도 없으면 하드 실패여야 한다(경고는 없어야 한다)")

    if failed:
        _stderr(
            "[골든 역참조 게이트 selftest] 실패 %d건:\n  %s"
            % (len(failed), "\n  ".join(failed))
        )
        return 1
    print(
        "[골든 역참조 게이트 selftest] 통과 — 차단 %d건·허용 %d건 확인."
        % (len(must_block), len(must_pass) + 1)
    )
    return 0


def main() -> None:
    _force_utf8()
    argv = sys.argv[1:]
    if not argv:
        _stderr(
            "이 게이트는 PreToolUse 훅으로 쓰지 않는다 — `--check` 또는 "
            "`--selftest`를 지정하라.\n%s" % __doc__
        )
        sys.exit(64)
    mode = argv[0]
    if mode == "--check":
        sys.exit(run_check())
    if mode == "--selftest":
        sys.exit(run_selftest())
    _stderr("알 수 없는 모드: %s\n%s" % (mode, __doc__))
    sys.exit(64)


if __name__ == "__main__":
    main()
