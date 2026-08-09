"""골든 역참조 게이트(원장 28g) — Red 단계 테스트.

## 배경

`harness/evals/golden/track-a-product.jsonl`의 `status: done` 골든은 `verify`
필드로 자신을 검증하는 테스트 파일을 가리킨다. 실측(리뷰어 전수 조사, 76건):

  - **경로 부재 0건** — `verify`가 가리키는 파일은 전부 실재한다.
  - **역참조(자기 GA-ID를 본문에 포함) 부재 6건** — GA-40·GA-47·GA-48·GA-52·
    GA-70·GA-71. 나머지 70/76(92%)은 이미 관례를 지킨다.

실제 사례(GA-52)는 `verify`가 존재하지 않는 파일을 가리켰는데 `status`가
`done`이라 "검증됨"으로 잘못 읽혔다(원장 28e — "처리했다는 보고가 검증 없이
나간다" 4회차 사례). 이 게이트는 그 형태의 드리프트를 자동으로 잡는다.

## 게이트가 할 일 (원장 28g, team-lead 지시)

  - **A-①** `status: done`인 골든의 `verify` 경로가 실재하는가 → **하드 실패**
    (오탐이 원리적으로 0 — 파일이 있거나 없거나 둘 중 하나다).
  - **A-②** 그 파일이 자기 GA-ID를 본문에 포함하는가 → **경고**(exit 0 유지).

## API 계약(test-writer 결정) — `gate_golden_backref.py`가 없어 새로 정한다

이 저장소의 기존 게이트(`gate_map_asset_provenance.py`의 `scan_path(path_str)
-> list[str]`, `gate_spec_mirror.py`의 `read_constants(path: Path = CONSTANTS)`)
와 같은 정신으로, **항목 하나를 순수 함수로 판정**하는 형태를 계약으로 건다:

    def check_entry(entry: dict, root: Path = ROOT) -> tuple[list[str], list[str]]:
        '''entry: JSONL 한 줄을 파싱한 dict(id·status·verify 등).
        반환: (hard_fails, warnings) — 각각 사람이 읽는 사유 문자열 리스트.
        hard_fails가 비어있지 않으면 `--check`가 exit 1을 낸다.
        warnings만 있으면 exit 0(경고만).
        entry에 `verify` 키가 없거나(트랙 B 스키마) status != "done"이면
        둘 다 빈 리스트 — 검사 대상이 아니다.'''

`root`가 기본값을 갖는 이유는 `read_constants`의 선례와 같다 — 실사용은 저장소
루트를, 테스트는 `tmp_path`를 격리해서 넘긴다.

이 계약은 **행동만 규정한다**(입력 dict → (hard_fails, warnings) 튜플). 내부
구현(정규식이냐 문자열 검색이냐, 헬퍼를 몇 개로 쪼개느냐)은 코더의 자유다.

## 실측으로 확정한 세부 규칙(코드를 읽지 않고는 알 수 없던 것들)

  1. **`verify`는 콤마로 여러 경로를 나열할 수 있다**(실측 7건: GA-11·17·41·
     42·43·57·58 — 예 `"tests/integration/rq-31-safe-zone.test.ts,tests/
     integration/rq-18-fall-damage.test.ts"`). 콤마 뒤 공백 유무가 섞여 있다
     (GA-11은 공백 없음, GA-17은 공백 있음) — 트리밍이 필요하다.
  2. **A-①(경로 실재)은 나열된 경로 전부가 실재해야 통과한다** — 하나라도
     없으면 하드 실패. 실측상 현재 7건 전부 모든 구성 요소가 실재해 이 규칙이
     현재 데이터에 오탐을 내지 않는다.
  3. **A-②(역참조)는 나열된 파일 중 "하나라도" GA-ID를 포함하면 경고하지
     않는다(ANY 의미론, ALL이 아니다)** — 실측: GA-17·GA-57은 두 파일 중
     정확히 하나만 자기 ID를 포함하는데(각각
     `rq-90-spread-seed-determinism.test.ts`만, `sim-movement-walls.test.ts`
     만) 리뷰어가 센 "이미 관례를 지키는 70건"에 포함된다. ALL을 요구하면 이
     둘에 새 오탐이 생겨 리뷰어 실측(70/76)과 이 게이트의 판정이 어긋난다.
  4. **`verify`가 테스트 파일만 가리키지 않는다** — GA-41·42·43은
     `scripts/smoke-deploy.sh`를 가리킨다(스모크 스크립트, RQ 아님). 존재
     검사·역참조 검사 둘 다 확장자·디렉터리로 대상을 좁히면 안 된다.

## 트랙 B(`track-b-harness.jsonl`) 판단 — 실물을 보고 정했다

실측: 7건 전부 `status: todo`이고, 스키마 자체가 `{id, type, task,
expected_behavior, rubric, judge, status}`라 **`verify` 필드가 아예 없다**.
따라서 A-①·A-②는 **애초에 검사할 필드가 없어 자동으로 제외된다** — 별도
예외 처리가 아니라 "verify 키가 없으면 스킵"이라는 하나의 규칙이 트랙 B 전체를
포함한다(위 계약의 "entry에 verify 키가 없으면 둘 다 빈 리스트"). GB가 훗날
`verify` 유사 필드를 도입하면 그때 재논의한다 — 지금 존재하지 않는 필드를
가정해 만들지 않는다(스코프 크리프 방지).

## "무엇을 보지 않는가" 초안(`gate_spec_mirror.py`의 동명 절 선례를 따른다 —
코더가 실제 구현 docblock에 옮길 것을 전제로 test-writer가 먼저 적는다)

  - **`status: todo` 골든** — 애초에 미검증이라 대조 대상이 아니다(스펙 미러
    게이트의 동일 원칙, `gate_spec_mirror.py` "무엇을 보지 않는가" 참고).
  - **`track-b-harness.jsonl`** — 위 판단대로 `verify` 필드 자체가 없어
    자동 제외(실측: 오늘 존재하는 골든에서 `_workspace/`를 가리키는 `verify`는
    0건이었다 — 그런 사례가 생기면 일반 경로와 동일하게 취급한다는 것이 지금
    시점의 판단이다. 별도 제외 규칙을 만들 근거가 아직 없다).
  - **A-②(경고)는 exit 1을 내지 않는다** — "관례일 뿐"이라는 근거(리뷰어
    92% 준수 실측)와 `gate_spec_mirror.py`가 문서 인용 오탐을 exit 1로 만들지
    않기로 한 것과 같은 정신. 경고가 실패로 바뀌면 소음 게이트가 되어 꺼진다.

## 이 파일이 다루지 않는 것

  - `--check`/`--selftest` CLI의 정확한 출력 문자열 포맷은 느슨하게만
    본다(`차단 N건·허용 M건` 패턴 존재 여부) — 정확한 조사(wording)는 구현
    자유.
  - JSONL 파싱 오류 처리(`gate_spec_mirror.py`의 `check_constant_mirrors`가
    이미 "JSONL 파싱 실패"를 다루는 선례가 있다) — 이번 라운드 요청 범위
    밖이라 테스트하지 않는다.

Node/TS 라운드의 결정론 규칙(ADR-0008)은 이 파일에 적용되지 않는다(Python
하네스 인프라, `src/shared` 아님) — 다만 `check_entry`가 파일시스템 외의
숨은 전역 상태(시각·난수)에 기대지 않는다는 것은 당연한 요구라 별도 테스트를
두지 않는다(그런 입력 자체가 없다).
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
HOOKS_DIR = ROOT / ".claude" / "hooks"
GATE_PATH = HOOKS_DIR / "gate_golden_backref.py"
GOLDEN_DIR = ROOT / "harness" / "evals" / "golden"

sys.path.insert(0, str(HOOKS_DIR))
import gate_golden_backref as gbg  # noqa: E402  — 그린필드 Red: 아직 없는 모듈


def _entry(**overrides) -> dict:
    base = {"id": "GA-TEST", "status": "done", "verify": "x.test.ts",
            "given": "", "when": "", "then": ""}
    base.update(overrides)
    return base


# ── A-① 경로 실재 (하드 실패) ───────────────────────────────────────────

def test_done_path_exists_and_contains_id_is_clean(tmp_path: Path) -> None:
    f = tmp_path / "tests" / "unit" / "foo.test.ts"
    f.parent.mkdir(parents=True)
    f.write_text("// GA-90: 앉은 자세 히트박스\n", encoding="utf-8")

    hard_fails, warnings = gbg.check_entry(
        _entry(id="GA-90", verify="tests/unit/foo.test.ts"), root=tmp_path)

    assert hard_fails == []
    assert warnings == []


def test_done_path_missing_is_hard_fail(tmp_path: Path) -> None:
    hard_fails, warnings = gbg.check_entry(
        _entry(id="GA-91", verify="tests/unit/does-not-exist.test.ts"),
        root=tmp_path)

    assert len(hard_fails) >= 1
    assert any("does-not-exist.test.ts" in msg for msg in hard_fails)
    # 파일을 열 수 없으니 역참조 검사 자체를 시도하지 않는다 —
    # 하드 실패가 경고보다 우선한다는 계약.
    assert warnings == []


def test_done_path_exists_no_id_is_warning_only(tmp_path: Path) -> None:
    f = tmp_path / "tests" / "unit" / "foo.test.ts"
    f.parent.mkdir(parents=True)
    f.write_text("// 다른 골든 이야기, 이 파일엔 자기 ID가 없다\n", encoding="utf-8")

    hard_fails, warnings = gbg.check_entry(
        _entry(id="GA-92", verify="tests/unit/foo.test.ts"), root=tmp_path)

    assert hard_fails == []
    assert len(warnings) >= 1
    assert any("GA-92" in msg for msg in warnings)


# ── 검사 대상 경계 (todo·트랙 B) ────────────────────────────────────────

def test_todo_status_not_checked_even_if_path_missing(tmp_path: Path) -> None:
    hard_fails, warnings = gbg.check_entry(
        _entry(id="GA-93", status="todo",
               verify="tests/unit/does-not-exist.test.ts"),
        root=tmp_path)

    assert hard_fails == []
    assert warnings == []


def test_entry_without_verify_field_is_skipped_not_crashed(tmp_path: Path) -> None:
    # 트랙 B 실제 스키마(`track-b-harness.jsonl`) — verify 키가 아예 없다.
    gb_entry = {"id": "GB-01", "type": "process", "task": "…",
                "expected_behavior": "…", "rubric": "…", "judge": "llm",
                "status": "todo"}
    hard_fails, warnings = gbg.check_entry(gb_entry, root=tmp_path)
    assert hard_fails == []
    assert warnings == []


def test_done_entry_without_verify_field_is_also_skipped_defensively(tmp_path: Path) -> None:
    # 오늘은 트랙 B에 done이 없지만(전부 todo), 스키마상 생길 수 있다 —
    # verify 필드 부재는 status와 무관하게 스킵해야 한다(방어적 계약).
    entry = {"id": "GB-99", "status": "done"}
    hard_fails, warnings = gbg.check_entry(entry, root=tmp_path)
    assert hard_fails == []
    assert warnings == []


# ── 콤마 다중 경로 (실측 GA-11·17·41·42·43·57·58) ───────────────────────

def test_multi_path_all_must_exist_for_hard_pass(tmp_path: Path) -> None:
    a = tmp_path / "tests" / "unit" / "a.test.ts"
    a.parent.mkdir(parents=True)
    a.write_text("// GA-94\n", encoding="utf-8")
    # b.test.ts는 만들지 않는다 — 존재하지 않는 두 번째 경로.

    hard_fails, warnings = gbg.check_entry(
        _entry(id="GA-94", verify="tests/unit/a.test.ts,tests/unit/b.test.ts"),
        root=tmp_path)

    assert len(hard_fails) >= 1
    assert any("b.test.ts" in msg for msg in hard_fails)


def test_multi_path_any_file_with_id_avoids_warning(tmp_path: Path) -> None:
    a = tmp_path / "tests" / "unit" / "a.test.ts"
    b = tmp_path / "tests" / "unit" / "b.test.ts"
    a.parent.mkdir(parents=True)
    a.write_text("// GA-95\n", encoding="utf-8")
    b.write_text("// 다른 내용, ID 없음\n", encoding="utf-8")

    hard_fails, warnings = gbg.check_entry(
        _entry(id="GA-95", verify="tests/unit/a.test.ts, tests/unit/b.test.ts"),
        root=tmp_path)

    # ANY 의미론(GA-17·GA-57 실측 근거) — 하나만 포함해도 경고하지 않는다.
    assert hard_fails == []
    assert warnings == []


def test_multi_path_no_file_with_id_is_warning(tmp_path: Path) -> None:
    a = tmp_path / "tests" / "unit" / "a.test.ts"
    b = tmp_path / "tests" / "unit" / "b.test.ts"
    a.parent.mkdir(parents=True)
    a.write_text("// ID 없음 1\n", encoding="utf-8")
    b.write_text("// ID 없음 2\n", encoding="utf-8")

    hard_fails, warnings = gbg.check_entry(
        _entry(id="GA-96", verify="tests/unit/a.test.ts,tests/unit/b.test.ts"),
        root=tmp_path)

    assert hard_fails == []
    assert len(warnings) >= 1


def test_verify_paths_are_trimmed_of_whitespace(tmp_path: Path) -> None:
    f = tmp_path / "tests" / "unit" / "spaced.test.ts"
    f.parent.mkdir(parents=True)
    f.write_text("// GA-97\n", encoding="utf-8")

    # 콤마 뒤 공백(GA-17 실제 표기 형태) — 트리밍 없이 " tests/unit/..."로
    # 읽으면 존재하지 않는 경로로 오판해 하드 실패가 난다.
    hard_fails, warnings = gbg.check_entry(
        _entry(id="GA-97", verify="tests/unit/spaced.test.ts,   tests/unit/spaced.test.ts"),
        root=tmp_path)

    assert hard_fails == []
    assert warnings == []


# ── 실제 저장소 골든 회귀 고정 (리뷰어 전수 조사 실측을 그대로 잠근다) ──

def test_real_track_a_zero_hard_fails_and_exactly_known_six_warnings() -> None:
    ids_with_warnings: set[str] = []
    total_hard_fails: list[str] = []
    for line in (GOLDEN_DIR / "track-a-product.jsonl").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        rec = json.loads(line)
        hard_fails, warnings = gbg.check_entry(rec, root=ROOT)
        total_hard_fails += hard_fails
        if warnings:
            ids_with_warnings.append(rec["id"])

    # 리뷰어 전수 조사(원장 28g 착수 근거) — 76건 중 경로 부재 0건.
    assert total_hard_fails == [], total_hard_fails
    # 역참조 부재 정확히 6건 — GA-40·47·48·52·70·71(실측, 위 docblock 참고).
    assert set(ids_with_warnings) == {"GA-40", "GA-47", "GA-48", "GA-52", "GA-70", "GA-71"}


def test_real_track_b_entries_all_skipped_no_crash() -> None:
    for line in (GOLDEN_DIR / "track-b-harness.jsonl").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        rec = json.loads(line)
        hard_fails, warnings = gbg.check_entry(rec, root=ROOT)
        assert hard_fails == [], (rec["id"], hard_fails)
        assert warnings == [], (rec["id"], warnings)


# ── CLI 경계(`--check`·`--selftest`) — 이 저장소 게이트 6개 전부의 기존 관례 ──

def test_cli_check_exits_zero_on_real_golden_dir() -> None:
    result = subprocess.run(
        [sys.executable, str(GATE_PATH), "--check"],
        # `text=True`만 쓰면 Windows 한국어 로케일(cp949)로 디코딩해 게이트가
        # UTF-8로 강제 출력하는 한글·em-dash를 읽다가 UnicodeDecodeError로
        # 죽는다(실측 — `_force_utf8()`가 게이트 쪽 stdout은 고치지만
        # subprocess의 디코딩 코덱까지는 못 바꾼다). 인코딩을 명시한다 —
        # 단언은 바뀌지 않는다.
        cwd=ROOT, capture_output=True, timeout=30, text=True, encoding="utf-8",
    )
    assert result.returncode == 0, (result.stdout, result.stderr)


def test_cli_selftest_exits_zero_and_reports_block_allow_counts() -> None:
    result = subprocess.run(
        [sys.executable, str(GATE_PATH), "--selftest"],
        # `text=True`만 쓰면 Windows 한국어 로케일(cp949)로 디코딩해 게이트가
        # UTF-8로 강제 출력하는 한글·em-dash를 읽다가 UnicodeDecodeError로
        # 죽는다(실측 — `_force_utf8()`가 게이트 쪽 stdout은 고치지만
        # subprocess의 디코딩 코덱까지는 못 바꾼다). 인코딩을 명시한다 —
        # 단언은 바뀌지 않는다.
        cwd=ROOT, capture_output=True, timeout=30, text=True, encoding="utf-8",
    )
    assert result.returncode == 0, (result.stdout, result.stderr)
    combined = result.stdout + result.stderr
    # 기존 5개 게이트가 전부 쓰는 "차단 N건·허용 M건"(`건` 생략 가능) 표기 —
    # gate_spec_mirror.py의 SELFTEST_COUNTS 정규식과 동일 형태를 기대한다.
    assert re.search(r"차단\s*\d+건?\s*[·,]\s*허용\s*\d+건?", combined), combined


# ── 스캔 표면 회귀 (원장 28g 독립 평가 FAIL 대응) ───────────────────────
#
# 위 `test_real_track_a_*`·`test_real_track_b_*`는 JSONL을 이 테스트 파일이
# 직접 파싱해 `check_entry(rec, root=ROOT)`를 부른다 — `check_entry`의 판정
# 계약은 검증하지만 **`_iter_golden_entries()`(GOLDEN_DIR·glob)는 지나지
# 않는다.** 평가자가 격리 실측으로 확인했다: `GOLDEN_DIR`을 없는 디렉터리로
# 바꾸거나 `_iter_golden_entries()`가 `return []`을 하거나 글롭을
# `track-b*`로 좁혀도(트랙 A 76건이 사라지고 트랙 B 7건만 남아 "0건"이 아니게
# 되는 형태) 위 두 테스트는 전부 그대로 통과한다 — 스캔 표면이 고장 나도
# 잡지 못한다. 아래 두 테스트가 그 표면을 직접 지난다.
#
# **스캔 건수를 얼마로 고정할지(team-lead 위임)**: "0보다 크다"는 세 변이
# 전부를 못 잡는다 — 특히 글롭 축소(트랙 B만 7건)는 0이 아니므로 그 기준을
# 통과해 버린다(팀장이 지적한 바로 그 형태). 그렇다고 "정확히 83건"으로
# 고정하면 골든이 늘어나는 정상적인 성장(이 저장소는 라운드마다 골든을
# 추가한다)마다 이 테스트가 깨진다 — 실패가 회귀 신호가 아니라 소음이 된다.
# **바닥값(`>=`)으로 고정한다**: 오늘 실측(트랙 A 76건 전부 done·트랙 B 7건
# 전부 todo)을 하한으로 두면 ① 정상 성장(골든 추가)에는 안 깨지고 ② 위 세
# 변이(경로 파괴·빈 리스트·글롭 축소) 전부에서 실제 수치가 바닥 밑으로
# 떨어져 죽는다 — 특히 트랙별로 바닥을 따로 두면(전체 합산 83이 아니라
# 트랙 A ≥76·트랙 B ≥7 각각) 글롭 축소가 "트랙 A는 0인데 트랙 B는 7"이라는
# 형태로 나타나 **어느 쪽이 사라졌는지까지 진단**된다(팀장 예시 "트랙 A가
# 최소 N건 스캔되는지"와 동일한 판단).
#
# 경고 건수(6건)는 반대로 **정확히 고정한다** — 이 수치는 골든이 늘어난다고
# 저절로 바뀌지 않는다(새 done 골든이 역참조를 빠뜨리면 그때 바뀌지만, 그건
# "이 테스트를 갱신해야 하는 진짜 신호"이지 소음이 아니다 — GA-52 사건 자체가
# "달라졌는데 아무도 안 봤다"였다).

def test_iter_golden_entries_scans_both_tracks_with_realistic_floor() -> None:
    """스캔 표면(GOLDEN_DIR + glob) 직접 호출 — P5(글롭 축소) 축을 트랙별
    바닥값으로 잡는다. 실측: 오늘 트랙 A 76건(전부 done)·트랙 B 7건(전부
    todo). `>=`인 이유는 위 섹션 코멘트 참고."""
    entries = gbg._iter_golden_entries()
    counts: dict[str, int] = {}
    for fname, _lineno, _rec in entries:
        counts[fname] = counts.get(fname, 0) + 1

    # 글롭이 `track-b*`로 좁혀지면 이 줄이 `counts.get(..., 0) == 0`이 되어
    # 바로 죽는다(팀장이 지적한 P5 형태 그대로).
    assert counts.get("track-a-product.jsonl", 0) >= 76, counts
    assert counts.get("track-b-harness.jsonl", 0) >= 7, counts


def test_cli_check_reports_scan_count_floor_and_known_warning_count() -> None:
    """`--check`의 stdout 내용을 직접 본다(`returncode == 0`만 보면 스캔이
    0건이어도, 또는 글롭이 트랙 B로 좁혀져도 통과한다 — 평가자 격리 실측)."""
    result = subprocess.run(
        [sys.executable, str(GATE_PATH), "--check"],
        # `text=True`만 쓰면 Windows 한국어 로케일(cp949)로 디코딩해 게이트가
        # UTF-8로 강제 출력하는 한글·em-dash를 읽다가 UnicodeDecodeError로
        # 죽는다(실측 — `_force_utf8()`가 게이트 쪽 stdout은 고치지만
        # subprocess의 디코딩 코덱까지는 못 바꾼다). 인코딩을 명시한다 —
        # 단언은 바뀌지 않는다.
        cwd=ROOT, capture_output=True, timeout=30, text=True, encoding="utf-8",
    )
    assert result.returncode == 0, (result.stdout, result.stderr)

    m = re.search(r"골든\s*(\d+)건\s*검사", result.stdout)
    assert m, result.stdout
    scanned = int(m.group(1))
    # 트랙 A(76) + 트랙 B(7) = 83이 오늘의 실측 최솟값. `>=`로 두는 이유는
    # 위 섹션 코멘트 참고 — 정상 성장에 안 깨지면서 글롭 축소(트랙 B만 7건)는
    # 83에 한참 못 미쳐 잡힌다.
    assert scanned >= 83, result.stdout

    # 경고 건수는 정확히 고정한다(위 섹션 코멘트) — GA-40·47·48·52·70·71.
    assert "경고 6건" in result.stdout, result.stdout
