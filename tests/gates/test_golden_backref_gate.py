"""골든 역참조 게이트(원장 28g) — Red 단계 테스트.

## 배경

`harness/evals/golden/track-a-product.jsonl`의 `status: done` 골든은 `verify`
필드로 자신을 검증하는 테스트 파일을 가리킨다. 실측(리뷰어 전수 조사, 76건):

  - **경로 부재 0건** — `verify`가 가리키는 파일은 전부 실재한다.
  - **역참조(자기 GA-ID를 본문에 포함) 부재 6건** — GA-40·GA-47·GA-48·GA-52·
    GA-70·GA-71. 나머지 70/76(92%)은 이미 관례를 지킨다. ⚠️ **원장 28i로
    정리됨** — 이 절은 28g 착수 시점(2026-08-08)의 실측을 그대로 남긴
    역사적 기록이다(append-only 원칙, `gate_spec_mirror.py`의 changelog
    제외 규칙과 같은 정신). **현재 상태는 6건 전부 정리돼 0건**이다 —
    `test_real_track_a_zero_hard_fails_and_zero_done_warnings` 참고.

실제 사례(GA-52) — ⚠️ **정정(원장 28g, PR #71 리뷰 blocker 1)**: 이 문단이
한때 "`status`가 `done`이라 '검증됨'으로 잘못 읽혔다"고 적었으나 **거짓**이다
(git 이력 전수 확인 — GA-52는 최초 등재부터 정정까지 **줄곧 `todo`**였고,
`done`+깨진 경로였던 적은 없다). **정확한 사실**: GA-52는 `verify`가
**존재한 적 없는 파일**을 가리킨 채 `status: todo`로 약 10일 남아 있었고
"미구현"으로 읽혔다 — 실제로는 다른 파일이 이미 검증하고 있었다. 원장 28e는
"처리했다는 보고가 검증 없이 나간다"는 같은 형태의 드리프트를
**다섯 번째(5회차)** 사례로 기록한다. ⚠️ **REV2(원장 28i, 사용자 결정
2026-08-09, PR #72 리뷰 blocker 2)**: 이 문단이 한때 "이 게이트는 그 `todo`
체류 상태를 못 잡는다(`todo`는 스캔 대상이 아니다) — 잡는 것은 `done`으로
전환하는 순간의 깨진 경로다"라고 적었는데, **그 축이 정확히 GA-52가 겪은
사고 형태(`todo`로 약 10일 체류)라 닫았다** — A-③(아래 "게이트가 할 일")이
`todo`도 `verify`가 깨져 있으면 경고를 낸다(하드 실패는 아니다). 이 게이트는
이제 `todo` 체류 중의 드리프트도 경고로, `done` 전환 시점의 드리프트는
하드 실패로 잡는다.

## 게이트가 할 일 (원장 28g, team-lead 지시)

  - **A-①** `status: done`인 골든의 `verify` 경로가 실재하는가 → **하드 실패**.
    ⚠️ **정정(독립 평가 major, 원장 28g)**: 이 문단이 한때 "오탐이 원리적으로
    0 — 파일이 있거나 없거나 둘 중 하나다"라고 적었으나 과장이었다 —
    `Path.is_file()`은 플랫폼 불변이 아니다. Windows·macOS는 대소문자를
    구분하지 않아 대소문자가 틀린 `verify`는 로컬(이 저장소의 개발 환경)에서는
    통과하고 **Linux CI에서는 하드 실패**한다(로컬↔CI 판정 불일치, 실측
    확인 — 다만 로컬 통과→CI 최종 차단 방향이라 안전하다). 오늘 76건은 전수
    확인 결과 전부 정확한 대소문자라 위험 0건이다(게이트 docblock 참고).
  - **A-②** 그 파일이 자기 GA-ID를 본문에 포함하는가 → **경고**(exit 0 유지).
  - **A-③(원장 28i, 사용자 결정 2026-08-09)** `status: todo`인 골든도 `verify`
    경로가 깨져 있으면 → **경고**(exit 0 유지, `done`의 하드 실패와는 별개
    축 — 하드 실패로는 승격하지 않는다, 작성 중 골든이 정당하게 임시·미래
    경로를 적을 수 있어서다). `todo`에서는 역참조(A-②)를 검사하지 않는다.
    경고 문면에 `(status: todo — 아직 작성 중, 하드 실패 아님)` 표지를
    붙여 `done`의 경고와 구분한다.

## API 계약(test-writer 결정) — `gate_golden_backref.py`가 없어 새로 정한다

이 저장소의 기존 게이트(`gate_map_asset_provenance.py`의 `scan_path(path_str)
-> list[str]`, `gate_spec_mirror.py`의 `read_constants(path: Path = CONSTANTS)`)
와 같은 정신으로, **항목 하나를 순수 함수로 판정**하는 형태를 계약으로 건다:

    def check_entry(entry: dict, root: Path = ROOT) -> tuple[list[str], list[str]]:
        '''entry: JSONL 한 줄을 파싱한 dict(id·status·verify 등).
        반환: (hard_fails, warnings) — 각각 사람이 읽는 사유 문자열 리스트.
        hard_fails가 비어있지 않으면 `--check`가 exit 1을 낸다.
        warnings만 있으면 exit 0(경고만).
        entry에 `verify` 키가 없거나 값이 빈 문자열이면 status와 무관하게
        둘 다 빈 리스트(검사 대상이 아니다). status == "done"이면 A-①(하드
        실패)·A-②(경고) 둘 다, status == "todo"면 A-③(경고만, 원장 28i)만
        적용한다. 그 외 status는 스킵한다.'''

⚠️ **정정(원장 28i, PR #72 리뷰 blocker 2)**: 위 계약문이 한때 "entry에
`verify` 키가 없거나(트랙 B 스키마) status != "done"이면 둘 다 빈 리스트"
라고 적었다 — A-③ 도입 이후 이건 **거짓**이다(`status == "todo"`도 이제
경고를 낼 수 있다). 계약 자체가 바뀐 것이지 이 절이 낡은 채 방치된 게
아니다 — 아래 `test_todo_status_with_missing_path_warns_but_does_not_
hard_fail`이 새 계약을 직접 반증하는 회귀 테스트다.

`root`가 기본값을 갖는 이유는 `read_constants`의 선례와 같다 — 실사용은 저장소
루트를, 테스트는 `tmp_path`를 격리해서 넘긴다.

이 계약은 **행동만 규정한다**(입력 dict → (hard_fails, warnings) 튜플). 내부
구현(정규식이냐 문자열 검색이냐, 헬퍼를 몇 개로 쪼개느냐)은 코더의 자유다.

## 실측으로 확정한 세부 규칙(코드를 읽지 않고는 알 수 없던 것들)

  1. **`verify`는 콤마로 여러 경로를 나열할 수 있다** — ⚠️ **정정(독립 평가
     major, 원장 28g)**: 이 문단이 한때 "실측 7건: GA-11·17·41·42·43·57·58"
     이라 적었으나 **실측은 4건**이다(GA-11·17·57·58). GA-41·42·43은 콤마가
     **없는 단일** 경로라 이 축에 포함되지 않는다 — 별개 발견인 "`verify`가
     테스트 파일만 가리키지 않는다"(아래 항목 4)와 뒤섞여 잘못 합산됐었다.
     예 `"tests/integration/rq-31-safe-zone.test.ts,tests/integration/
     rq-18-fall-damage.test.ts"`. 콤마 뒤 공백 유무가 섞여 있다(GA-11은
     공백 없음, GA-17은 공백 있음) — 트리밍이 필요하다.
  2. **A-①(경로 실재)은 나열된 경로 전부가 실재해야 통과한다** — 하나라도
     없으면 하드 실패. 실측상 현재 4건 전부 모든 구성 요소가 실재해 이 규칙이
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

  - **`status: todo` 골든** — ⚠️ **정정(원장 28i, PR #72 리뷰 blocker 2)**:
    이 항목이 한때 "애초에 미검증이라 대조 대상이 아니다(스펙 미러 게이트의
    동일 원칙)"라고 적었다 — A-③ 도입 이후 **더 이상 완전히 스킵되지
    않는다.** `todo`는 **하드 실패 대상은 아니지만 경고 대상이다** —
    `verify` 경로가 깨져 있으면 경고를 낸다. `todo`에서 **여전히 보지
    않는 것**은 역참조(A-②)뿐이다 — 작성 중 골든의 `verify`가 아직 자기
    ID를 담지 않은 것은 정상이라 검사하지 않는다.
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

def test_todo_status_with_missing_path_warns_but_does_not_hard_fail(tmp_path: Path) -> None:
    """A-③(원장 28i, 사용자 결정 2026-08-09) — 방향 전환이지 약화가 아니다.

    이 테스트가 한때 `test_todo_status_not_checked_even_if_path_missing`이라는
    이름으로 "todo는 경로가 없어도 완전히 스킵된다"를 단언했다. GA-52가
    존재한 적 없는 파일을 가리킨 채 `status: todo`로 약 10일 체류한 사고
    (원장 28e·28g "왜 만드는가" 참고)가 정확히 이 축이었는데, 그 옛 계약은
    그 상태를 못 잡았다(독립 평가 blocker 2) — 사용자 결정으로 이 축을
    닫았다. `done`처럼 하드 실패로 승격하지는 않는다(작성 중 골든이 정당하게
    임시·미래 경로를 적을 수 있어, 하드 실패면 정상 작업 흐름을 막는 소음
    게이트가 된다) — **경고**로 승격했다. "검사를 안 한다"에서 "검사하되
    경고로 그친다"로 바뀐 것이라 검증력은 늘었지 줄지 않았다.
    """
    hard_fails, warnings = gbg.check_entry(
        _entry(id="GA-93", status="todo",
               verify="tests/unit/does-not-exist.test.ts"),
        root=tmp_path)

    # 하드 실패로는 승격되지 않는다 — done과는 다른 축(위 docblock 참고).
    assert hard_fails == []
    assert len(warnings) == 1
    assert "GA-93" in warnings[0]
    # done의 경고와 구분되는 표지 — team-lead 지시("읽는 사람이 이건 아직
    # 작성 중임을 알아야 한다").
    assert "todo" in warnings[0]


def test_todo_status_with_empty_verify_is_still_fully_skipped(tmp_path: Path) -> None:
    """minor 3(PR #72 리뷰) — `todo` + 빈 문자열 `verify` 조합을 고정한다.

    `verify` 키 부재·빈 문자열 검사가 status 검사보다 **먼저** 와야(코드
    순서) 트랙 B(`todo`뿐이고 `verify` 필드 자체가 없다)가 A-③(경고)에
    잘못 걸리지 않는다 — 리뷰어가 실측으로 그 순서를 확인했지만, `todo` +
    **빈 문자열**(필드는 있는데 값이 "") 조합을 고정하는 테스트는 어느
    층에도 없었다. `verify: ""`인 `done` 골든은 이미
    `test_done_entry_without_verify_field_is_also_skipped_defensively`류가
    다루지만, 그 방어가 `todo`에도 그대로 적용되는지는 별도로 확인해야
    한다 — A-③가 "verify가 있는데 깨졌다"만 다루고 "verify 자체가 없다/
    비었다"는 여전히 완전 스킵이어야 하기 때문이다(게이트 docblock "무엇을
    보지 않는가" 참고).
    """
    hard_fails, warnings = gbg.check_entry(
        _entry(id="GA-98", status="todo", verify=""), root=tmp_path)

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

def test_real_track_a_zero_hard_fails_and_zero_done_warnings() -> None:
    """원장 28i — 6건(GA-40·47·48·52·70·71) 정리 이후의 새 회귀 고정.

    ⚠️ **이름·범위 갱신(원장 24bz, 2026-08-11)**: 고정 대상은 이제 `done`
    골든의 경고뿐이다. `status: todo`의 깨진 경로는 허용한다 — 근거는 아래
    `assert` 앞 주석과 위 섹션 코멘트에 있다.

    이 테스트가 한때 `test_real_track_a_zero_hard_fails_and_exactly_known_
    six_warnings`라는 이름으로 "경고 정확히 6건"을 단언했다. 그 6건은
    `it()` 이름에 `GA-NN:` 접두를 붙여 역참조를 채웠다(각 골든의 `then`을
    실제로 판별하는 테스트를 골라 붙였다 — 근거는 `_workspace/28i-cleanup/
    02_test-writer_backref.md`). **경고 0건은 의도된 신호다** — 1차 라운드
    문서에 이미 "경고 건수는 골든이 늘어난다고 저절로 바뀌지 않는다,
    바뀐다면 그게 진짜 신호"라고 적었고, 지금이 바로 그 신호다.
    """
    done_with_warnings: list[str] = []
    todo_with_warnings: list[str] = []
    total_hard_fails: list[str] = []
    for line in (GOLDEN_DIR / "track-a-product.jsonl").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        rec = json.loads(line)
        hard_fails, warnings = gbg.check_entry(rec, root=ROOT)
        total_hard_fails += hard_fails
        if warnings:
            bucket = todo_with_warnings if rec.get("status") == "todo" else done_with_warnings
            bucket.append(rec["id"])

    # 리뷰어 전수 조사(원장 28g 착수 근거) — 76건 중 경로 부재 0건. 정리
    # 이후에도 그대로 유지된다(하드 실패 축은 이번 라운드가 건드리지 않았다).
    assert total_hard_fails == [], total_hard_fails
    # 역참조 부재 0건 — 6건 전부 GA-NN: 접두로 정리됐다(원장 28i).
    #
    # ⚠️ **고정을 두 종류로 가른다(원장 24bz — 사용자 결정 2026-08-11).**
    # 이 단언은 한때 `done`·`todo`를 합쳐 "경고 0건"을 요구했다. 그런데 게이트
    # 문서(A-③)가 "`status: todo` 골든이 현재 0건 — **정하는 것은 앞으로의
    # 관행이다**"라고 그 관행을 미결로 남겨 뒀고, RQ-73 스펙 라운드가 그것을
    # 처음 건드렸다: **스펙 PR이 구현 이전에 골든을 먼저 등록**하면 `verify`가
    # 가리키는 테스트 파일이 아직 없다.
    #
    # 합쳐서 0으로 두면 **스펙이 골든 없이 머지되어** 「검증 기준 없는 스펙」이
    # 한 라운드 동안 남는다. 그래서 **약화가 아니라 분리**를 택했다 — 정말
    # 지켜야 할 축(`done`이라 "검증됨"으로 읽히는데 역참조가 없는 것)은 **0건
    # 그대로**이고, `todo`의 깨진 경로만 허용한다. 위 docstring의 "경고 건수가
    # 바뀌면 그게 진짜 신호"는 유효하다 — 신호를 무시한 게 아니라 **읽고
    # 관행을 정했다.**
    #
    # ⚠️ `todo` 체류가 방치되는 것(GA-52가 약 10일)은 이 테스트가 막지 않는다.
    # 그 축은 **원장 24bz**가 소유한다 — 구현 라운드가 GA-90~94를 `done`으로
    # 승격하는 것이 그 행의 할 일에 적혀 있다.
    assert done_with_warnings == [], done_with_warnings


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
# 경고 건수는 반대로 **정확히 고정한다** — 이 수치는 골든이 늘어난다고
# 저절로 바뀌지 않는다(새 done 골든이 역참조를 빠뜨리면 그때 바뀌지만, 그건
# "이 테스트를 갱신해야 하는 진짜 신호"이지 소음이 아니다 — GA-52 사건 자체가
# "달라졌는데 아무도 안 봤다"였다). ⚠️ **원장 28i 갱신** — 이 값이 한때
# 6건(GA-40·47·48·52·70·71)이었으나, 그 6건을 `it()` 이름에 `GA-NN:` 접두를
# 붙여 정리해 **0건**이 됐다(§`test_real_track_a_zero_hard_fails_and_zero_
# done_warnings` docstring 참고). 값이 바뀐 것 자체가 "정확히 고정"이 의도대로
# 작동한 증거다 — 바뀌지 않았다면 정리가 반영 안 된 것이다.
#
# ⚠️ **원장 24bz 갱신(2026-08-11) — 고정을 종류별로 가른다.** 위 문단의 "총
# 건수를 정확히 고정한다"는 이제 **거짓**이다. `done` 골든의 역참조 부재는
# **0건 그대로** 고정하고, `status: todo` 골든의 깨진 `verify` 경로는 세지
# 않는다(총계는 오늘 5건 — GA-90~94). 스펙 PR이 구현 이전에 골든을 등록하면
# `verify`가 가리키는 테스트 파일이 아직 없기 때문이고, 합쳐서 0으로 두면
# **스펙이 골든 없이 머지되어** "검증 기준 없는 스펙"이 한 라운드 남는다.
# 게이트 문서 A-③이 이 관행을 미결로 남겨 뒀고 사용자 결정으로 확정했다.
# ⚠️ 위 문단의 "달라졌는데 아무도 안 봤다"(GA-52) 취지는 **유효하다** — 신호를
# 무시한 것이 아니라 읽고 관행을 정했다. `todo` 체류가 방치되는 축은 이 파일이
# 아니라 **원장 24bz**가 소유한다.

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

    # 경고는 **종류별로** 고정한다(원장 24bz — 사용자 결정 2026-08-11). 한때
    # `"경고 0건"` 문자열을 통째로 요구했는데, 그러면 `todo` 골든이 하나라도
    # 생기는 순간 깨진다 — 그 관행을 게이트 문서 A-③이 미결로 남겨 뒀고
    # RQ-73 스펙 라운드가 정했다(근거는 위 `test_real_track_a_...`의 주석).
    #
    # 게이트가 두 종류를 출력에서 구분한다 — `todo`의 깨진 경로 줄에는 GA-ID
    # 뒤에 `(status: …)`가 붙고 `done`의 역참조 위반 줄에는 붙지 않는다.
    # **`done` 쪽만 0건으로 고정한다.** 게이트가 그 표기를 없애면 아래 필터가
    # `done` 줄로 오분류해 **더 엄격해질 뿐**이라(경고를 놓치는 방향이 아니다)
    # 실패로 드러난다.
    warning_lines = [
        ln for ln in result.stdout.splitlines()
        if re.search(r"\bGA-\d+\b", ln) and "verify" in ln
    ]
    # ⚠️ **줄 수와 헤더 건수를 대조한다**(PR #78 1차 리뷰 major M2). 위 필터만
    # 두면 게이트가 **경고 상세 줄 출력을 끊는** 변이에서 `warning_lines`가 0이
    # 되어 실제 위반이 있는데도 통과한다 — 삭제된 `assert "경고 0건" in stdout`은
    # 그 변이에서 실패했으므로 그 축만은 **순수한 약화**였다(리뷰어 격리 실측).
    # 헤더의 총 건수와 파싱한 줄 수가 어긋나면 출력 형식이 바뀐 것이고, 그때는
    # 아래 `done` 단언이 무력해지므로 여기서 먼저 죽어야 한다.
    m_warn = re.search(r"경고\s*(\d+)건", result.stdout)
    assert m_warn, result.stdout
    assert len(warning_lines) == int(m_warn.group(1)), (warning_lines, result.stdout)

    done_warning_lines = [ln for ln in warning_lines if "(status:" not in ln]
    assert done_warning_lines == [], result.stdout


# ══════════════════════════════════════════════════════════════════════
# 24cm — 골든 승격 게이트 사각: 빈 verify가 status와 무관하게 완전 스킵된다
# ══════════════════════════════════════════════════════════════════════
#
# 같은 사고가 두 라운드 연속으로 났다(원장 24cm 전문 참고):
#   ① RQ-70·71 라운드 — GA-112·113이 `status: "todo"` + `verify: ""`인 채로
#      구현 커밋(`1e1f57c`)까지 갔다. 커밋 `307c957`이 뒤늦게 닫았다.
#   ② 24cu 라운드 — GA-119·120이 같은 상태로 구현 커밋까지 갔다. 커밋
#      `8d24dd0`이 뒤늦게 닫았다.
# 두 번 다 `gate_golden_backref.py --check`는 「경고 0건」을 냈다 — `check_entry`가
# 빈 `verify`를 `status`와 무관하게 완전 스킵하기 때문이다(위 §"검사 대상
# 경계" 참고, 216~225행). 독립 평가가 대신 잡았다.
#
# 채택안 ③(원장 24cm, 사용자 결정 2026-08-19): 변경 경로 중 `tests/**`인
# 파일을 읽어 거기 언급된 GA-ID를 모으고, 그 골든의 `verify`가 비어 있으면
# **경고**한다(하드 실패 아님 — "실패하는 소음 게이트는 꺼진다",
# `gate_trigger_due.py`가 이미 못박은 것과 같은 이유). Red 커밋에서도 짖는
# 것이 의도된 동작이다 — Red-first 영역은 테스트가 먼저 커밋되고 승격은
# Green 뒤라, 그 사이가 정확히 「빈 verify + GA 언급」 구간이다.
#
# ## API 계약(test-writer 결정, 원장 24cm이 위임) — `gate_golden_backref.py`에
# 아직 없어 이 라운드에서 새로 정한다. `gate_map_asset_provenance.scan_path`·
# `gate_spec_mirror.read_constants`·이 파일 자신의 `check_entry`와 같은 정신 —
# **행동만 규정**하고 내부 구현(정규식이냐 문자열 검색이냐)은 코더의 자유다.
#
#     def check_changed_paths(paths: list[str], root: Path = ROOT) -> list[str]:
#         '''paths: 변경된 파일 경로 리스트(gate_trigger_due.py의 --check-paths와
#         같은 조달 형태 — CLI가 인자 없이 불리면 호출자가 stdin에서 채운다).
#
#         paths 중 `tests/`로 시작하는(디렉터리 접두) 경로만 골라 root 기준으로
#         읽는다. 각 파일 본문에서 `\\bGA-\\d+\\b` 패턴으로 언급된 GA-ID를 전부
#         모은다(한 파일에 여럿이어도, 여러 파일에 걸쳐도 합집합). `tests/`로
#         시작하지 않는 경로는 파일을 열지 않는다 — 본문에 GA-ID가 아무리
#         많아도 무시한다(harness/ 문서·원장이 그런 경우다).
#
#         모은 GA-ID 각각에 대해 root/harness/evals/golden/*.jsonl 전체(모든
#         트랙)에서 그 id의 entry를 찾는다. entry가 없는 id(오타·미래 ID)는
#         무시한다 — 죽지 않는다. entry가 있고 그 verify 필드가 없거나 빈
#         문자열이면(status와 무관하게) 경고 문자열 하나를 반환 리스트에
#         담는다(그 문자열은 최소한 GA-ID를 포함한다). verify가 채워져 있으면
#         (그 경로가 실재하는지는 이 함수의 책임이 아니다 — A-①이 이미
#         담당한다) 무시한다.
#
#         반환값은 경고 문자열 리스트 **하나뿐**이다(check_entry의
#         (hard_fails, warnings) 튜플과 다르다 — 이 모드에 하드 실패 축이
#         없다).'''
#
#     def run_check_paths(paths: list[str]) -> int:
#         '''CLI 배선. 인자가 없으면 stdin에서 줄 단위로 읽는다
#         (gate_trigger_due.run_check_paths와 동일 조달 형태). 경고가 있으면
#         사람이 읽는 형태로 출력한다. 반환값은 **항상 0**이다(경고 게이트 —
#         하드 실패 없음).'''
#
# **CLI 모드 이름: `--check-paths`** — `gate_trigger_due.py`의 동명 모드와
# 조달 형태(인자 없으면 stdin 줄 단위)·항상 exit 0 계약을 그대로 맞춘다
# (team-lead 지시: "입력 조달은 gate_trigger_due.py --check-paths와 같은
# 형태를 쓴다"). 같은 하네스 안에서 "변경 경로를 받아 원장/골든을 대조하는"
# 두 게이트가 같은 어휘를 쓰면 다음 사람이 배선을 유추하기 쉽다.
#
# ⚠️ **합성 fixture로 격리한다** — 순수 함수 테스트(`check_changed_paths` 직접
# 호출)는 전부 `tmp_path`에 골든·테스트 파일을 직접 써서 실제 저장소 골든
# 상태에 의존하지 않는다. 오늘 GA-119·120은 이미 승격돼 있어(원장 24cm) 그
# 상태에 의존하는 테스트는 내일 깨진다. CLI 경계 테스트만 실 저장소를 쓰되
# **exit code만** 단언한다(경고 내용은 단언하지 않는다 — 승격이 있을 때마다
# 깨지는 것을 피한다).


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _write_golden(root: Path, *entries: dict, fname: str = "track-a-product.jsonl") -> None:
    golden_dir = root / "harness" / "evals" / "golden"
    golden_dir.mkdir(parents=True, exist_ok=True)
    lines = [json.dumps(e) for e in entries]
    (golden_dir / fname).write_text("\n".join(lines) + "\n", encoding="utf-8")


# ── 반드시 덮을 것 1: 사고 1 재현(GA-112·113, RQ-70·71 라운드) ──────────

def test_promotion_gap_incident1_ga112_113_decal_test_warns(tmp_path: Path) -> None:
    """사고 1 재현(원장 24cm) — 데칼 렌더 배선 테스트가 GA-112·113을 본문에
    23회 언급했는데(실측) 그 골든이 `status: todo` + `verify: ""`로 남아
    있었다. 실제로는 이 상태가 구현 커밋(`1e1f57c`)까지 조용히 통과했고
    커밋 `307c957`이 뒤늦게 닫았다 — 이 테스트는 그 순간을 재현한다.
    """
    _write(
        tmp_path / "tests" / "unit" / "hit-decal-instancing.test.ts",
        "// GA-112: 데칼 인스턴싱 렌더 배선\n// GA-113: 피격 무상한 단언\n",
    )
    _write_golden(
        tmp_path,
        {"id": "GA-112", "status": "todo", "verify": ""},
        {"id": "GA-113", "status": "todo", "verify": ""},
    )

    warnings = gbg.check_changed_paths(
        ["tests/unit/hit-decal-instancing.test.ts"], root=tmp_path)

    assert any("GA-112" in w for w in warnings), warnings
    assert any("GA-113" in w for w in warnings), warnings


# ── 반드시 덮을 것 2: 사고 2 재현(GA-119·120, 24cu 라운드) ──────────────

def test_promotion_gap_incident2_ga119_120_new_test_warns(tmp_path: Path) -> None:
    """사고 2 재현(24cu 라운드, 커밋 `8d24dd0`) — 같은 형태의 재발. 신규
    테스트가 GA-119를 16회·GA-120을 5회 언급하는데(실측) 그 골든이 todo +
    빈 verify인 채로 구현 커밋까지 갔다. GA-112·113(사고 1)과 **같은 형태의
    2연속**임을 이 테스트가 고정한다.
    """
    _write(
        tmp_path / "tests" / "integration" / "24cu-feature.test.ts",
        ("// GA-119\n" * 16) + ("// GA-120\n" * 5),
    )
    _write_golden(
        tmp_path,
        {"id": "GA-119", "status": "todo", "verify": ""},
        {"id": "GA-120", "status": "todo", "verify": ""},
    )

    warnings = gbg.check_changed_paths(
        ["tests/integration/24cu-feature.test.ts"], root=tmp_path)

    assert any("GA-119" in w for w in warnings), warnings
    assert any("GA-120" in w for w in warnings), warnings


# ── 반드시 덮을 것 3: 승격 후 침묵 ───────────────────────────────────────

def test_promotion_after_verify_filled_is_silent(tmp_path: Path) -> None:
    """승격 후 침묵 — 같은 tests/** 변경, 같은 GA-ID 언급이지만 verify가
    채워지면(승격 완료) 더 이상 경고가 나지 않는다. "Red 커밋에서는 짖고
    승격 후에는 조용해진다"는 의도된 동작(원장 24cm)의 반대쪽 절반이다.
    """
    _write(
        tmp_path / "tests" / "unit" / "hit-decal-instancing.test.ts",
        "// GA-112: 데칼 인스턴싱 렌더 배선\n// GA-113: 피격 무상한 단언\n",
    )
    _write_golden(
        tmp_path,
        {"id": "GA-112", "status": "done",
         "verify": "tests/unit/hit-decal-instancing.test.ts"},
        {"id": "GA-113", "status": "done",
         "verify": "tests/unit/hit-decal-instancing.test.ts"},
    )

    warnings = gbg.check_changed_paths(
        ["tests/unit/hit-decal-instancing.test.ts"], root=tmp_path)

    assert warnings == []


# ── 반드시 덮을 것 4: 스펙 전용 PR 침묵 ──────────────────────────────────

def test_spec_only_pr_with_no_tests_paths_is_silent(tmp_path: Path) -> None:
    """스펙 전용 PR 침묵 — 변경 경로에 `tests/**`가 전혀 없으면(스펙·ADR
    문서만 바뀐 PR) 골든에 빈 verify가 있어도 경고 0건이다 — `tests/`를 안
    건드리므로 애초에 훑을 대상이 없다."""
    _write_golden(
        tmp_path,
        {"id": "GA-112", "status": "todo", "verify": ""},
    )

    warnings = gbg.check_changed_paths(
        ["harness/specs/requirements.md", "harness/adr/0015-player-model-geometry.md"],
        root=tmp_path)

    assert warnings == []


# ── 반드시 덮을 것 6: tests/ 밖 파일의 GA-ID 언급은 무시 ────────────────

def test_non_tests_path_mentioning_ga_id_is_ignored(tmp_path: Path) -> None:
    """`tests/` 밖 파일이 GA-ID를 언급해도 무시한다 — `harness/` 문서·원장은
    GA-ID를 수없이 언급한다. 그것으로 짖으면 소음 게이트가 된다(원장 24cm
    "반드시 덮을 것" 6)."""
    _write(
        tmp_path / "harness" / "progress.md",
        "GA-112 GA-113 " * 20,
    )
    _write_golden(
        tmp_path,
        {"id": "GA-112", "status": "todo", "verify": ""},
        {"id": "GA-113", "status": "todo", "verify": ""},
    )

    warnings = gbg.check_changed_paths(["harness/progress.md"], root=tmp_path)

    assert warnings == []


# ── 방어 — 골든에 없는 GA-ID를 언급해도 죽지 않는다 ─────────────────────

def test_mentioned_ga_id_without_golden_entry_is_ignored_not_crashed(tmp_path: Path) -> None:
    """골든에 아예 없는 GA-ID(오타·아직 등록 안 된 미래 ID)를 언급해도
    KeyError 없이 무시한다 — "실패하는 소음 게이트는 꺼진다"는 크래시에도
    적용된다(운영 중 크래시하는 게이트는 경고보다 나쁘다)."""
    _write(tmp_path / "tests" / "unit" / "future.test.ts", "// GA-999\n")
    _write_golden(tmp_path, {"id": "GA-1", "status": "done", "verify": "x.test.ts"})

    warnings = gbg.check_changed_paths(["tests/unit/future.test.ts"], root=tmp_path)

    assert warnings == []


# ── 반환 타입 계약 ────────────────────────────────────────────────────

def test_check_changed_paths_returns_a_plain_list_of_warnings(tmp_path: Path) -> None:
    """계약 — 반환은 `list[str]` 하나다(`check_entry`의 `(hard_fails,
    warnings)` 튜플과 다르다 — 이 모드에 하드 실패 축이 없다). 빈 입력은
    빈 리스트를 낸다."""
    result = gbg.check_changed_paths([], root=tmp_path)
    assert result == []


# ── 반드시 덮을 것 5: exit code가 항상 0이다(CLI 경계) ──────────────────
#
# 아래 CLI 테스트는 **실 저장소**를 대상으로 돈다(subprocess가 새 프로세스를
# 띄우므로 모듈 상수 ROOT를 monkeypatch로 격리할 수 없다 — `--check`·
# `--selftest`의 기존 CLI 테스트와 같은 제약). 그래서 **exit code만**
# 단언하고 경고 *내용*은 단언하지 않는다 — 실 골든이 승격될 때마다 이
# 테스트가 깨지는 것을 피한다(team-lead 지시).

def test_cli_check_paths_mode_exists_and_exits_zero_with_empty_stdin() -> None:
    result = subprocess.run(
        [sys.executable, str(GATE_PATH), "--check-paths"],
        cwd=ROOT, capture_output=True, timeout=30, text=True, encoding="utf-8",
        input="",
    )
    assert result.returncode == 0, (result.stdout, result.stderr)


def test_cli_check_paths_mode_exits_zero_with_argv_path() -> None:
    """인자로 경로를 직접 준 형태(`gate_trigger_due.py --check-paths P...`와
    같은 조달 형태) — 경고 유무와 무관하게 exit 0이어야 한다."""
    result = subprocess.run(
        [sys.executable, str(GATE_PATH), "--check-paths",
         "tests/gates/test_golden_backref_gate.py"],
        cwd=ROOT, capture_output=True, timeout=30, text=True, encoding="utf-8",
    )
    assert result.returncode == 0, (result.stdout, result.stderr)


def test_cli_check_paths_reads_from_stdin_when_no_argv() -> None:
    """인자 없이 stdin으로 경로를 받는 조달 형태 — `gate_trigger_due.py
    --check-paths`와 동일 계약(위 파일 131~139행)."""
    result = subprocess.run(
        [sys.executable, str(GATE_PATH), "--check-paths"],
        cwd=ROOT, capture_output=True, timeout=30, text=True, encoding="utf-8",
        input="tests/gates/test_golden_backref_gate.py\n",
    )
    assert result.returncode == 0, (result.stdout, result.stderr)


# ══════════════════════════════════════════════════════════════════════
# 24cm 2차 — PR #88 1차 리뷰 blocker·major 대응 (team-lead 위임, pytest 층)
# ══════════════════════════════════════════════════════════════════════
#
# 구현은 team-lead가 이미 했다(`.claude/hooks/gate_golden_backref.py`·
# `scripts/check.sh`·`.github/workflows/ci.yml`) — 이 절은 그 처방을 pytest로
# 독립 검증한다(검증 격리). 아래 각 테스트는 리뷰가 지목한 지적 하나씩과
# 대응한다:
#
#   - blocker: 배선(`check.sh`)이 준 입력(마지막 커밋 하나의 diff)만으로는
#     승격을 잊는 "탈출 커밋"에서 **0경로**를 받는다 — 테스트는 앞선 Red
#     커밋에 이미 있어서다. 실측(리뷰): 사고 1의 탈출 커밋 `1e1f57c`,
#     사고 2의 탈출 커밋 `6440e4d` 둘 다 `tests/`를 한 개도 안 건드린다.
#     처방: `.github/workflows/ci.yml`에 three-dot(PR 전체) diff 스텝을 더한다.
#   - major M2: 경고 0건이면 아무 출력도 없어서 "정상"(스펙 전용 PR)과
#     "고장"(경로 조달 파이프 붕괴)이 구분되지 않았다. 처방: 경고 0건에도
#     `변경 경로 N개 중 tests/ M개 검사` 생존 신호를 낸다.
#   - major M3: "항상 exit 0" 단언이 공허했다 — 기존 CLI 테스트 3건이 전부
#     경고 0건 입력만 줘서 「경고가 있으면 return 1」(M4)·「경고 출력 제거」
#     (M9) 변이가 pytest 전체 통과·selftest exit 0으로 살아남았다.


def test_incident_reproduction_single_commit_diff_yields_zero_but_three_dot_yields_two(
        tmp_path: Path) -> None:
    """리뷰 blocker 처방 — check.sh 배선(마지막 커밋 하나의 diff)만으로는
    승격을 잊는 "탈출 커밋"에서 0경로를 받는다. 실제 커밋 SHA(`1e1f57c`·
    `6440e4d`)에는 의존하지 않고 그 **형태**를 합성 fixture로 고정한다 —
    테스트 파일은 디스크에 이미 있다(이전 Red 커밋에서 커밋됨). "탈출
    커밋"의 변경 경로 목록에는 `src/`만 있다 → 0건. 같은 파일 상태에서
    three-dot diff가 주는 전체 집합(테스트 파일 포함)을 넘기면 → 2건.

    check_changed_paths는 git 이력을 모른다 — 순전히 `paths` 인자가 준
    경계를 지키는지가 이 함수의 책임이고, 이 테스트가 그 경계를 직접
    단언한다(같은 골든·같은 파일 상태에서 입력 목록만 바꾼다).
    """
    _write(
        tmp_path / "tests" / "unit" / "hit-decal-instancing.test.ts",
        "// GA-112: 데칼 인스턴싱 렌더 배선\n// GA-113: 피격 무상한 단언\n",
    )
    _write(
        tmp_path / "src" / "client" / "effects" / "hitDecal.ts",
        "// 데칼 렌더 배선 구현 — 이 파일 자체는 GA-ID를 언급하지 않는다\n",
    )
    _write_golden(
        tmp_path,
        {"id": "GA-112", "status": "todo", "verify": ""},
        {"id": "GA-113", "status": "todo", "verify": ""},
    )

    single_commit_diff = ["src/client/effects/hitDecal.ts"]
    three_dot_diff = [
        "src/client/effects/hitDecal.ts",
        "tests/unit/hit-decal-instancing.test.ts",
    ]

    escape_commit_warnings = gbg.check_changed_paths(single_commit_diff, root=tmp_path)
    three_dot_warnings = gbg.check_changed_paths(three_dot_diff, root=tmp_path)

    assert escape_commit_warnings == [], escape_commit_warnings
    assert len(three_dot_warnings) == 2, three_dot_warnings


def test_run_check_paths_exits_zero_and_prints_when_warnings_present(monkeypatch, capsys) -> None:
    """major M3 처방 — 「경고가 있으면 return 1」(M4)·「경고 출력 제거」
    (M9) 변이를 한 테스트로 죽인다. 기존 CLI 테스트 3건은 전부 경고 0건인
    입력만 줘서 이 두 변이가 살아남았다(리뷰 관측). `check_changed_paths`를
    스텁으로 바꿔 `run_check_paths`의 배선(exit code·출력)만 격리해서
    본다 — 리뷰가 monkeypatch + capsys를 제안했다."""
    monkeypatch.setattr(
        gbg, "check_changed_paths",
        lambda paths: ["GA-9001 (status: todo) — 스텁 경고: 승격을 잊었는지 확인하라"],
    )

    rc = gbg.run_check_paths(["tests/unit/whatever.test.ts"])
    captured = capsys.readouterr()

    assert rc == 0, "M4 — 경고가 있어도 exit 0이어야 한다(경고 게이트)"
    assert "GA-9001" in captured.out, "M9 — 경고 내용이 실제로 출력돼야 한다"


def test_run_check_paths_emits_survival_signal_even_with_empty_input(capsys) -> None:
    """major M2 처방(생존 신호) — 빈 입력에서도 조용히 return하지 않고
    한 줄을 낸다. 게이트 소스 주석("조기 return을 없앴다")이 명시하는
    바로 그 축 — 예전 코드가 `if not paths: return 0`으로 일찍 빠졌다면
    이 테스트가 죽는다."""
    rc = gbg.run_check_paths([])
    captured = capsys.readouterr()

    assert rc == 0
    assert captured.out.strip() != "", "경고 0건에도 생존 신호가 나와야 한다"
    assert "변경 경로 0개" in captured.out
    assert "tests/ 0개" in captured.out


def test_run_check_paths_survival_signal_distinguishes_total_from_tests_count(capsys) -> None:
    """major M2 처방 — 생존 신호가 N(변경 경로 총수)과 M(tests/ 경로 수)을
    **구분해서** 담는지 확인한다. 그래야 "N=0"(경로 조달 파이프 고장)과
    "M=0"(스펙 전용 PR, tests/를 안 건드림 — 정상)이 출력만으로 갈린다.
    tests/ 경로는 실존하지 않는 파일명을 쓴다 — `run_check_paths`의 `tested`
    집계는 문자열 접두사만 보므로(파일 존재 여부와 무관) 실 저장소 골든
    상태에 의존하지 않고도 N≠M을 확인할 수 있다."""
    rc = gbg.run_check_paths([
        "harness/specs/requirements.md",
        "src/client/x.ts",
        "tests/unit/does-not-exist-fixture-24cm.test.ts",
    ])
    captured = capsys.readouterr()

    assert rc == 0
    assert "변경 경로 3개" in captured.out, captured.out
    assert "tests/ 1개" in captured.out, captured.out


def test_ci_workflow_wires_check_paths_with_three_dot_diff() -> None:
    """blocker 처방의 배선 축 — `check.sh`(로컬 마지막 커밋 diff)만으로는
    탈출 커밋에서 0경로가 된다(위 테스트가 그 형태를 고정한다). 실제
    방어선은 `.github/workflows/ci.yml`의 three-dot(PR 전체) diff 스텝이다.
    YAML 파서 대신 텍스트 근접도로 본다 — 인프라 배선이라 정확한 블록
    경계 파싱은 이 테스트 범위 밖이다(`gate_trigger_due.py`의 마크다운 표
    파싱과 같은 정신 — 완전한 파서 없이 필요한 구조만 본다).

    ⚠️ **판단(team-lead 위임 4번 항목)**: 포함하기로 했다 — three-dot 스텝이
    이 사고의 유일한 실질 방어선이고(`check_changed_paths` 자체는 입력
    경계를 안 가린다 — 위 테스트가 그것을 보여 준다), 그 스텝을 되돌리는
    변경을 잡는 자동 그물이 이 저장소 다른 어디에도 없다. 과하다고 판단되면
    (예: YAML 구조가 자주 리팩터링돼 이 텍스트 근접 검사가 소음이 되면)
    떼어내도 좋다 — 그 판단은 리뷰어에게 넘긴다.
    """
    text = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")

    m = re.search(r"golden_backref\.py --check-paths", text)
    assert m, "ci.yml에 gate_golden_backref.py --check-paths 호출이 없다"

    # 호출 근방(같은 run: 블록 안)에 three-dot(...HEAD) diff가 있는지 —
    # 400자 앞 window로 본다(정확한 YAML 블록 경계 파싱은 범위 밖).
    window = text[max(0, m.start() - 400):m.start()]
    assert "...HEAD" in window, (
        "gate_golden_backref.py --check-paths 호출 근방에 three-dot diff가 없다"
        " — check.sh와 같은 단일 커밋 diff로 배선됐다면 탈출 커밋에서 다시 "
        "0경로가 된다(리뷰 blocker가 지목한 바로 그 형태)"
    )
