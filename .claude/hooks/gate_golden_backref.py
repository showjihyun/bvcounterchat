#!/usr/bin/env python3
r"""골든 역참조 게이트 — `status: done` 골든이 자신이 주장하는 대로 검증됐는지 본다.

## 왜 만드는가 (원장 28e·28g)

`harness/evals/golden/track-a-product.jsonl`의 `status: done` 골든은 `verify`
필드로 자신을 검증하는 테스트 파일(또는 스크립트)을 가리킨다. 이 필드는 두 가지를
암묵적으로 주장한다 — ① 그 경로가 실재한다 ② 그 파일이 실제로 이 GA를 검증한다.
둘 다 **아무 게이트도 확인하지 않았다.**

실제로 일어난 일(⚠️ **REV — 최초 서술이 실측과 달랐다, 독립 평가 blocker 2
정정**): GA-52는 `status: todo` 상태로 **존재하지 않는 파일**
(`tests/integration/rq-32-map-volumes.test.ts` — 어느 커밋에도 존재한 적이
없다)을 `verify`로 가리킨 채 2026-07-29부터 2026-08-08까지(약 10일)
남아 있었다. `todo`였으므로 "검증됨"으로 **읽힌 적은 없다** — 최초 버전의
"`status: done`이라 검증됨으로 읽혔다"는 서술은 **거짓**이었다(git 이력
전수 역추적으로 확인, `todo`+깨진 경로였던 적은 있어도 `done`+깨진 경로였던
적은 한 번도 없다). 사실은: `done`으로 전환하는 순간 아무 검사 없이 거짓
검증 주장이 성립할 수 있는 상태였고, 그 발견은 감사가 아니라 **우연**이었다
(다음 라운드 후보를 조사하던 중 발견). 원장 28e는 "처리했다는 보고가 검증
없이 나간다"는 같은 형태의 드리프트가 **다섯 번째** 반복된 사례로 이 건을
기록한다 — 사람 주의력이 이 계열에서 계속 진다. **이 게이트는 그 전환
시점을 하드 실패로 막는다.** ✅ **REV2(원장 28i, 사용자 결정
2026-08-09)** — 최초 버전은 여기서 "`todo` 체류 중에는 잡지 않는다"고
적었는데, 그 축이 정확히 GA-52가 겪은 실제 사고 형태(`todo`로 약 10일
체류)였다 — **닫았다**: `todo`도 `verify`가 깨져 있으면 이제 경고를
낸다(하드 실패는 아니다, A-③ 참고 — 작성 중 골든이 정당하게 임시 경로를
적을 수 있어 하드 실패로 만들면 소음 게이트가 된다).
`gate_spec_mirror.py`(원장 26af)가 "문서가 인용한 **수치**가 정본과 어긋난다"를
자동화했듯, 이 게이트는 "**`done`으로 확정된** 골든이 자기 자신의 검증 존재를
정확히 주장하는가"를 자동화한다.

## 이 게이트가 하는 일 (원장 28g, team-lead 지시)

  - **A-①** `status: done`인 골든의 `verify` 경로가 **파일로서** 실재하는가 →
    **하드 실패**(`--check`가 exit 1). ⚠️ **REV(독립 평가 major 1 정정)** —
    최초 서술은 "오탐이 원리적으로 없다 — 파일은 있거나 없거나 둘 중 하나다"
    였는데 과장이었다: **같은 플랫폼에서는** 오탐이 없지만, 판정에 쓰는
    `Path.is_file()`은 플랫폼 불변이 아니다. Windows·macOS 기본 파일시스템은
    대소문자를 구분하지 않는다 — 대소문자가 틀린 `verify`는 그 두 플랫폼(이
    저장소의 로컬 개발 환경)에서는 통과하고 **Linux CI에서는 하드 실패**한다
    (로컬↔CI 판정 불일치, 실측 확인). 오늘 76건은 전수 확인 결과 전부 정확한
    대소문자의 추적 파일이라 위험이 없다(실측 0건) — 그리고 이 불일치는
    **안전한 방향**이다(로컬 통과 → CI가 최종 차단, 그 반대가 아니다). 실제
    대소문자 비교(파일시스템을 순회해 각 경로 성분의 실제 표기와 대조)까지
    구현할지는 **coder 판단으로 보류한다** — 오늘 위험 0건 대비 구현 복잡도가
    크고, Linux CI가 어차피 최종 방어선이라 로컬에서 이를 못 잡아도 머지
    전에 걸린다(비용 대비 이득 낮음). `.exists()`가 아니라 `.is_file()`을
    쓴다 — `verify`가 디렉터리를 가리키는 경우까지 하드 실패로 잡는다(오늘
    데이터에는 이 형태가 없어 동작 변화 없음, 잠재 오탐 축 하나를 사전에
    닫는 무비용 수정).
  - **A-②** 그 파일(들)이 자기 GA-ID를 본문에 포함하는가(역참조) → **경고만**
    (exit 0 유지). "관례"이지 절대 규칙이 아니다 — 실측 92%(70/76)만 지킨다.
  - **A-③(원장 28i, 사용자 결정 2026-08-09)** `status: todo`인 골든도 `verify`
    경로가 깨져 있으면 → **경고**(exit 0 유지, `done`의 하드 실패와는 별개
    축). GA-52가 존재한 적 없는 파일을 가리킨 채 `status: todo`로 약 10일
    체류했던 것이 이 게이트의 원래 동기였는데, 최초 버전(A-①이 `done`
    한정)은 그 상태를 못 잡았다(독립 평가 blocker 2, §"왜 만드는가" 참고) —
    이 축을 닫는다. ⚠️ **하드 실패로는 승격하지 않는다** — 작성 중 골든이
    정당하게 임시·미래 경로를 적을 수 있어, 하드 실패로 만들면 정상 작업
    흐름을 막는 소음 게이트가 된다(`gate_trigger_due.py`가 이미 못박은
    "실패하는 소음 게이트는 꺼진다"와 같은 이유). `todo`에서는 역참조(A-②)를
    검사하지 않는다 — 작성 중 골든의 `verify`가 아직 자기 ID를 담지 않은
    것은 정상이다. 경고 문면에 `(status: todo — 아직 작성 중, 하드 실패
    아님)` 표지를 붙여 `done`의 경고와 구분한다. **오늘 실제 영향은 0이다**
    (`status: todo` 골든이 현재 0건, 실측) — 정하는 것은 앞으로의 관행이다.

## 실측으로 확정한 세부 규칙 (골든 전수 조사, 코드를 안 읽고는 알 수 없던 것들)

  - **`verify`는 콤마로 여러 경로를 나열할 수 있다**(⚠️ **REV — 최초 서술이
    "실측 7건"이라 적었으나 실측은 4건이다, 독립 평가 major 2 정정**: 다중
    경로는 **GA-11·17·57·58 4건**뿐이다. GA-41·42·43은 콤마가 없는 **단일**
    경로라 이 축의 실측에 포함되지 않는다 — 별개 발견인 "`verify`가 테스트
    파일만 가리키지 않는다"와 뒤섞여 잘못 합산됐었다, 바로 아래 항목 참고).
    콤마 뒤 공백 유무가 섞여 있다(`"a,b"`·`"a, b"` 둘 다 있다) — 트리밍한다.
  - **A-①(경로 실재)은 나열된 경로 전부가 실재해야 통과한다** — 하나라도
    없으면 하드 실패.
  - **A-②(역참조)는 ANY 의미론이다(ALL이 아니다)** — GA-17·GA-57은 나열된 두
    경로 중 정확히 하나에만 자기 ID가 있는데, 리뷰어가 이미 "관례를 지키는
    70건"에 이 둘을 포함해 셌다. ALL을 요구하면 이미 준수 중인 두 건에 새
    오탐이 생겨 리뷰어 실측과 이 게이트의 판정이 어긋난다.
  - **`verify`가 테스트 파일만 가리키지 않는다**(별개 발견, 다중 경로 축과
    무관) — GA-41·42·43은 `scripts/smoke-deploy.sh`(스모크 스크립트)를
    가리킨다. 두 검사 모두 확장자·디렉터리로 대상을 좁히지 않는다.
  - **하드 실패가 경고보다 우선한다** — 경로 중 하나라도 없으면 그 항목의
    역참조 검사 자체를 시도하지 않는다(열 수 없는 파일의 "내용"을 판정하는
    것은 무의미하다).

## 무엇을 보지 않는가 (`gate_spec_mirror.py`의 동명 절과 같은 원칙)

  - **`status: todo` 골든** — ⚠️ **REV(원장 28i, 사용자 결정 2026-08-09) —
    더 이상 완전히 스킵되지 않는다.** 최초 버전은 이 절에서 "애초에
    미검증이라 대조 대상이 아니다"라고 적었는데, GA-52가 존재한 적 없는
    파일을 가리킨 채 `todo`로 약 10일 체류한 사고(§"왜 만드는가")가 정확히
    이 축이었다 — `todo`는 **하드 실패 대상은 아니지만 경고 대상이다**(A-③).
    `verify` 경로가 깨져 있으면 경고를 낸다. **`todo`에서 여전히 보지 않는
    것**: 역참조(A-②) — 작성 중 골든의 `verify`가 아직 자기 ID를 담지 않은
    것은 정상이라 검사하지 않는다.
  - **`track-b-harness.jsonl`(프로세스 골든)** — 스키마 자체가 `{id, type,
    task, expected_behavior, rubric, judge, status}`라 `verify` 필드가 없다.
    별도 예외 분기를 두지 않는다 — "entry에 `verify` 키가 없으면 (status와
    무관하게) 스킵"이라는 계약 하나가 트랙 B 전체를 자동으로 포함한다(A-③
    승격 이후에도 이 규칙은 그대로다 — `todo` 승격은 "`verify`가 있는데
    깨졌다"는 축만 다루고, "`verify` 자체가 없다"는 여전히 완전 스킵이다).
    오늘 존재하는 골든에서 `_workspace/`(gitignore 대상)를 가리키는
    `verify`는 0건이다 — 그런 사례가 생기면 일반 경로와 동일하게 취급하는
    것이 지금 시점의 판단이다(별도 제외 규칙을 만들 근거가 아직 없다).
  - **`verify`가 빈 문자열("")인 경우** — status와 무관하게 실 데이터에
    0건이라 필드 부재와 동일하게(스킵) 취급한다(A-③ 승격 이후에도 그대로).
    하드 실패로 볼지는 실제 사례가 생기면 재논의한다(스코프 크리프 방지).
  - **A-②·A-③(경고)는 절대 exit 1을 내지 않는다** — A-②는 "관례일 뿐"이라는
    근거(실측 92% 준수)를, A-③은 "작성 중 골든의 정상 상태"라는 근거를 하드
    규칙으로 승격하지 않는다. 경고가 실패로 바뀌면 소음 게이트가 되어
    꺼진다(`gate_spec_mirror.py`가 문서 인용 오탐을 exit 1로 만들지 않은
    것과 같은 정신, `gate_trigger_due.py`가 "실패하는 소음 게이트는
    꺼진다"로 명시한 것과도 같은 원칙).
  - **JSONL 파싱 오류 처리** — `gate_spec_mirror.py`의 `check_constant_mirrors`가
    이미 그 형태를 다루므로 이 게이트는 조용히 건너뛴다(스코프 밖).

## API

    def check_entry(entry: dict, root: Path = ROOT) -> tuple[list[str], list[str]]:
        '''entry: JSONL 한 줄을 파싱한 dict. 반환: (hard_fails, warnings) —
        사람이 읽는 사유 문자열 리스트. entry에 `verify` 키가 없거나 값이 빈
        문자열이면 status와 무관하게 둘 다 빈 리스트(검사 대상이 아니다).
        status == "done"이면 A-①(하드 실패)·A-②(경고) 둘 다, status == "todo"면
        A-③(경고만, 원장 28i)만 적용한다. 그 외 status는 스킵한다.'''

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

    `entry`에 `verify` 키가 없거나(트랙 B 스키마) 값이 빈 문자열이면 `status`와
    **무관하게** 둘 다 빈 리스트다(검사 대상이 아니다 — 위 docblock "무엇을
    보지 않는가" 참고, 작성 중 골든의 정상 상태다).

    `status == "done"`이면 A-①(경로 실재, 하드 실패)·A-②(역참조, 경고) 둘 다
    적용한다. `status == "todo"`면 경로 실재만 확인해 깨져 있으면 **경고**(하드
    실패 아님, 원장 28i — 사용자 결정 2026-08-09)한다 — 역참조(A-②)는 확인하지
    않는다(작성 중 골든의 `verify`가 아직 자기 ID를 담지 않은 것은 정상이다).
    그 외 `status` 값은 스킵한다. ⚠️ **`blocked_on_spec`은 "미정의"가 아니라
    `harness/evals/README.md`가 정의한 상태다**(PR #72 리뷰 major 3 — 초안이
    미정의로 적었다). 오늘 0건이라 동작 영향은 없으나, 그 상태가 생기면
    **깨진 경로를 조용히 통과시킨다** — `todo`와 같은 축이라 승격 여부를
    함께 판단해야 한다(원장 28m).
    """
    if "verify" not in entry:
        return [], []

    verify = entry.get("verify")
    entry_id = str(entry.get("id", ""))
    if not isinstance(verify, str) or not verify.strip():
        # 빈 verify(실 데이터 0건) — status와 무관하게 필드 부재와 동일하게
        # 스킵한다(위 docblock "무엇을 보지 않는가" 참고, coder 판단으로 남긴
        # 결정 — 작성 중 골든의 정상 상태다).
        return [], []

    status = entry.get("status")
    if status not in ("done", "todo"):
        return [], []

    paths = [p.strip() for p in verify.split(",") if p.strip()]

    if status == "todo":
        # 원장 28i(사용자 결정) — `todo` + 깨진 `verify`는 경고로 승격한다.
        # GA-52가 존재한 적 없는 파일을 가리킨 채 `todo`로 약 10일 체류했던
        # 것이 이 게이트의 원래 동기였는데(원장 28e·28g), 최초 버전은 `done`
        # 전환 시점만 막아 그 체류 자체는 못 잡았다(독립 평가 blocker 2).
        # ⚠️ 하드 실패로는 승격하지 않는다 — 작성 중 골든이 정당하게 임시·
        # 미래 경로를 적을 수 있다(관례 위반이 아니라 정상 작업 흐름,
        # `gate_trigger_due.py`가 이미 못박은 "실패하는 소음 게이트는
        # 꺼진다"와 같은 이유). 역참조(A-②)는 `todo`에서 검사하지 않는다.
        missing = [rel for rel in paths if not (root / rel).is_file()]
        if not missing:
            return [], []
        return [], [
            "%s (status: todo — 아직 작성 중, 하드 실패 아님): verify 경로가 "
            "존재하지 않는다 — %s" % (entry_id, ", ".join(missing))
        ]

    # status == "done" — A-①(경로 실재, 하드 실패) + A-②(역참조, 경고).
    hard_fails: list[str] = []
    for rel in paths:
        # `.is_file()`(`.exists()`가 아니다, 독립 평가 major 1) — 디렉터리를
        # 가리키는 verify까지 하드 실패로 잡는다.
        if not (root / rel).is_file():
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
    entries = _iter_golden_entries()
    if not entries:
        # 독립 평가 blocker 1 — 스캔 표면(GOLDEN_DIR·glob·이터레이터)이 고장
        # 나면 판정할 대상이 0건이 되어 "하드 실패 0건"으로 조용히 초록을
        # 낸다. 고장 난 센서는 없는 센서보다 나쁘다(check.sh·ci.yml이 이미
        # 명시한 원칙) — 골든을 한 건도 못 읽으면 그 자체를 하드 실패로 낸다.
        _stderr(
            "[골든 역참조 게이트] 골든을 한 건도 읽지 못했다 — 스캔 표면이 고장 났다"
            "(GOLDEN_DIR 경로나 *.jsonl 글롭을 확인하라): %s" % GOLDEN_DIR
        )
        return 1

    hard_total: list[str] = []
    warn_total: list[str] = []
    for fname, lineno, rec in entries:
        hard, warn = check_entry(rec)
        hard_total += ["  %s:%d %s" % (fname, lineno, m) for m in hard]
        warn_total += ["  %s:%d %s" % (fname, lineno, m) for m in warn]

    if warn_total:
        print(
            "[골든 역참조 게이트] 경고 %d건(exit 0 유지 — 두 종류가 섞인다: `done` "
            "골든의 역참조 관례 위반, 그리고 `todo` 골든의 깨진 경로. 각 줄 "
            "끝의 표지를 보라):\n%s" % (len(warn_total), "\n".join(warn_total))
        )

    if hard_total:
        _stderr(
            "[골든 역참조 게이트] 하드 실패 %d건 — status: done인 골든의 verify 경로가 "
            "존재하지 않는다:\n%s\n"
            "verify는 실재하는 파일을 가리켜야 한다 — done으로 전환하는 순간 아무 검사 "
            "없이 거짓 검증 주장이 성립하는 것을 막는다(원장 28e·28g)."
            % (len(hard_total), "\n".join(hard_total))
        )
        return 1

    print(
        "[골든 역참조 게이트] 하드 실패 0건 (골든 %d건 검사, 경고 %d건)."
        % (len(entries), len(warn_total))
    )
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
            (
                "다중 경로: 하나라도 없으면 하드 실패(전부 실재해야 통과)",
                {"id": "GA-S7", "status": "done",
                 "verify": "tests/unit/clean.test.ts,tests/unit/missing2.test.ts"},
            ),
            (
                "verify가 디렉터리를 가리키면 하드 실패(.is_file(), 독립 평가 major 1)",
                {"id": "GA-S8", "status": "done", "verify": "tests/unit"},
            ),
        ]
        for name, entry in must_block:
            hard, warn = check_entry(entry, root=root)
            if not hard:
                failed.append("차단 실패 — %s" % name)
            if warn:
                # 하드 실패가 있으면 경고를 더하지 않는다는 계약(§docblock
                # "하드 실패가 경고보다 우선한다")도 여기서 함께 지킨다.
                failed.append("차단 케이스에서 경고가 함께 나왔다(우선순위 위반) — %s" % name)

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
                "status: todo + verify 경로 실재 -> 완전 통과(조용함, 역참조는 검사 안 함)",
                {"id": "GA-S4", "status": "todo", "verify": "tests/unit/clean.test.ts"},
                0,
                0,
            ),
            (
                "verify 필드 없음(트랙 B 실제 스키마) -> status와 무관하게 스킵",
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
            (
                "원장 28i A-③ — status: todo + verify 경로 부재 -> 경고(하드 실패 아님, 승격된 축)",
                {"id": "GA-S9", "status": "todo", "verify": "tests/unit/missing.test.ts"},
                0,
                1,
            ),
        ]
        for name, entry, want_hard, want_warn in must_pass:
            hard, warn = check_entry(entry, root=root)
            if len(hard) != want_hard or len(warn) != want_warn:
                failed.append(
                    "오탐/미탐 — %s: hard=%d(기대 %d) warn=%d(기대 %d)"
                    % (name, len(hard), want_hard, len(warn), want_warn)
                )

        # 원장 28i — 경고 문면에 done과 구분되는 표지가 있는지(team-lead 지시,
        # "읽는 사람이 이건 아직 작성 중임을 알아야 한다"). 위 GA-S9 케이스를
        # 재사용해 메시지 내용까지 확인한다(개수만으로는 문면 내용을 못 잡는다).
        _todo_hard, todo_warn = check_entry(
            {"id": "GA-S9", "status": "todo", "verify": "tests/unit/missing.test.ts"}, root=root
        )
        if not todo_warn or "todo" not in todo_warn[0]:
            failed.append(
                "원장 28i 표지 — todo 승격 경고 문면에 'todo' 표지가 없다: %r" % todo_warn
            )

    # 독립 평가 blocker 1 — 스캔 표면(`GOLDEN_DIR` 상수 + `_iter_golden_entries()`
    # 자신) 자체가 고장 나면 `check_entry`가 아무리 정확해도 판정 대상이 0건이
    # 되어 조용히 초록이 난다. `check_entry`와 달리 `_iter_golden_entries()`는
    # `root` 인자가 없어(모듈 상수 `GOLDEN_DIR`를 직접 읽는다) 임시 디렉터리로
    # 격리할 수 없다 — 그래서 이 검사만 예외적으로 **실 저장소 골든**을
    # 대상으로 한다(`gate_spec_mirror.read_constants()`가 정본 파일을 직접
    # 파싱해 검증하는 것과 같은 정신 — 그 함수도 `root` 격리 대상이 아니다).
    real_entries = _iter_golden_entries()
    if not real_entries:
        failed.append(
            "스캔 표면 — _iter_golden_entries()가 골든을 한 건도 읽지 못했다"
            "(GOLDEN_DIR=%s) — run_check()의 blocker 1 방어가 실제로 발화하는지 "
            "확인하라" % GOLDEN_DIR
        )

    if failed:
        _stderr(
            "[골든 역참조 게이트 selftest] 실패 %d건:\n  %s"
            % (len(failed), "\n  ".join(failed))
        )
        return 1
    print(
        "[골든 역참조 게이트 selftest] 통과 — 차단 %d건·허용 %d건 확인."
        % (len(must_block), len(must_pass))
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
