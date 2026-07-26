#!/usr/bin/env python3
"""coder 역할의 tests/ **기존 단언 접촉** 차단 게이트.

원장 17f(파이프라인 무결성) 후속. `.claude/agents/coder.md`가 "테스트 파일을
절대 수정하지 않는다"를 프롬프트로만 강제하고 있었다 — coder의 `tools:`에
`Write`·`Edit`·`Bash`가 있어 도구 수준에서는 막히지 않았다. 이 hook은 그
프롬프트 강제의 **일부**(Write/Edit/MultiEdit 경유만)를 결정론적 게이트로
승격한다.

**차단 범위는 "coder의 tests/ 쓰기 전체"가 아니다 — ADR-0011 결정 3**(승인,
2026-07-24)을 그대로 따른다: test-after 영역에서는 coder가 테스트를 함께
작성할 수 있고, coder의 `tests/` 변경은 **순증(신규 파일·신규 it)만 허용** —
기존 단언의 수정·삭제·완화는 금지. Red-first 영역(tests/는 test-writer
전유물)은 이 hook이 아니라 파이프라인 프롬프트가 강제한다(coder 세션에는
test-writer가 이미 커밋한 테스트 파일을 건드릴 이유가 없어야 정상 경로다).

**1차 버전의 결함(리뷰 blocker 4로 발견)**: `agent_type == "coder" and
is_test_path(...)` 한 줄로 coder의 tests/ 쓰기 전체를 막았다 — 이러면
ADR-0011이 명시적으로 허용한 "coder가 신규 테스트 파일을 만드는" 표준 경로
(원장 22b: "test-after, tests/ 순증만")의 **첫 Write에서 파이프라인이 죽는다**.
이 버전은 "신규 파일 생성"과 "기존 단언에 손대는 것"을 구분한다.

**판정 규칙**(payload에 `tool_name`이 있다 — Claude Code 2.1.220 실측,
`_workspace/debt/01_report.md` 참고):
  - `Write` + 대상 경로가 **존재하지 않음** → 신규 파일 생성 = 순증 → 통과.
  - `Write` + 대상 경로가 **이미 존재** → 파일 전체를 덮어쓰는 것이라 기존
    단언이 통째로 사라질 수 있다 → 차단.
  - `Edit` → `old_string`이 `new_string`에 **그대로 포함**되면 "앵커 뒤에 새
    내용을 붙이는" 순수 삽입으로 보고 통과. 포함되지 않으면(기존 내용이
    바뀌거나 사라짐) 차단.
  - `MultiEdit` → `tool_input.edits` 배열의 각 원소에 같은 순수 삽입 판정을
    적용, 하나라도 위반하면 차단. **주의**: 이 저장소가 실행 중인 Claude
    Code 2.1.220에서는 `MultiEdit`이 permission 엔진에 "알려진 툴 아님"으로
    나온다(17g 조사에서 실측 — `harness/evals/README.md` 참고). 즉 이
    분기는 라이브로 트리거해 payload 형태를 확인하지 못했다 — 필드가 없거나
    예상과 다르면 **fail-open**(통과)한다. 실제 형태가 확인되면 이 주석과
    함께 갱신할 것.
  - 그 외(알 수 없는 tool_name) → fail-open.
  - **애매하면 통과시킨다**(reviewer 지침) — 순증 강제의 정본은 evaluator·
    reviewer의 diff 검사(ADR-0011)다. 이 hook은 명백한 위반만 막는 보조
    그물이다.

**어떻게 "coder"를 식별하는가**: PreToolUse hook의 stdin JSON에 서브에이전트
호출 시 `agent_type` 필드가 실려 온다 — 값은 `.claude/agents/<name>.md`
frontmatter의 `name:`과 정확히 일치한다(Claude Code 2.1.220 실측). 메인 세션
호출에는 이 키 자체가 없다. `agent_type`이 없거나 `"coder"`가 아니면(메인
세션·test-writer·evaluator·reviewer 전부 포함) 조용히 통과시킨다(fail-open).

**정직하게 남는 구멍**: `matcher`는 `Write|Edit|MultiEdit`뿐이다. coder가
`Bash`(예: 셸 리다이렉트·python heredoc)로 `tests/`에 쓰면 이 hook은 아예
호출되지 않는다. 그 경로는 기존 evaluator 사후 diff 검출(SHA 기준점 사슬)이
계속 맡는다. "순수 삽입" 판정 자체도 완전하지 않다 — 예를 들어 새 파일
안에서 기존 단언을 지우고 겉보기엔 다른 문구로 재작성하면(신규 파일 경로라
통과) 이 hook은 잡지 못한다. 이 hook은 **결정론적 보조 그물**이지, ADR-0011
강제의 유일한 수단이 아니다.

경로 판정 헬퍼(`is_test_path`)는 `gate_spec_freeze.py`의
`is_implementation_path`와 같은 정규화 로직(백슬래시 치환·`ROOT` 상대화·
최상위 세그먼트 판정)을 별도로 유지한다 — **한쪽을 고치면 반대쪽도 확인할
것**(리뷰 minor 4, 두 스크립트가 독립 실행 파일이라 임포트 공유를 안 함).

실행 모드
---------
  (stdin에 JSON)   PreToolUse hook. exit 2 = 도구 호출 차단.
  --selftest       내장 검증.
"""
import json
import sys
from pathlib import Path

# tests/ 로 간주하는 최상위 디렉토리 — gate_spec_freeze.py의 BLOCKED_TOP_DIRS
# 중 테스트 관련 부분집합과 동일하게 유지한다(이 저장소는 실제로는 tests/만
# 쓰지만, test/·__tests__/도 흔한 관례라 오탐 없는 여유분으로 남긴다).
TEST_TOP_DIRS = {"tests", "test", "__tests__"}

ROOT = Path(__file__).resolve().parent.parent.parent


def _normalize(path_str: str) -> Path:
    """백슬래시를 슬래시로 정규화한 Path. gate_spec_freeze.py의
    is_implementation_path와 동일한 이유(Windows 훅 payload는 절대 경로
    백슬래시로 온다) — 한쪽을 고치면 반대쪽도 확인할 것(리뷰 minor 4)."""
    return Path(path_str.replace("\\", "/"))


def is_test_path(path_str: str) -> bool:
    """이 경로가 테스트 디렉토리 안인가. 경로 구분자·상대/절대 표기에 무관하게
    판정한다."""
    if not path_str:
        return False
    p = _normalize(path_str)
    try:
        rel = p.resolve().relative_to(ROOT) if p.is_absolute() else p
    except (ValueError, OSError):
        return False  # 프로젝트 밖 경로는 이 게이트의 관할이 아니다
    parts = [seg for seg in rel.parts if seg not in (".", "")]
    return bool(parts) and parts[0] in TEST_TOP_DIRS


def _path_exists(path_str: str) -> bool:
    """대상 경로가 이미 파일시스템에 있는가 — Write가 신규 생성인지
    기존 파일 덮어쓰기인지 구분하는 유일한 근거(payload 자체에는 이
    구분이 없다 — Write의 tool_input은 신규·기존 모두 {file_path, content}
    뿐임을 라이브로 확인했다)."""
    try:
        p = _normalize(path_str)
        if not p.is_absolute():
            p = ROOT / p
        return p.exists()
    except OSError:
        return False


def is_pure_insertion(old_string: object, new_string: object) -> bool:
    """old_string이 new_string 안에 그대로 포함되면 "기존 내용 보존 + 새
    내용 추가"로 판정한다 — ADR-0011 결정 3의 "신규 it 추가"에 해당하는
    가장 흔한 패턴(앵커 텍스트 뒤/앞에 새 코드를 붙이는 Edit). old_string이
    new_string 밖으로 사라지거나 바뀌면 기존 단언을 건드린 것으로 본다."""
    if not isinstance(old_string, str) or not isinstance(new_string, str):
        return False  # 필드가 없거나 형태가 다르면 안전하게 "삽입 아님"
    return old_string in new_string


def touches_existing_assertion(tool_name: str, tool_input: dict) -> bool:
    """coder가 tests/ 경로에 대해 이 도구 호출을 실행하면 기존 단언을
    건드리는가. True면 차단 대상."""
    file_path = tool_input.get("file_path") or ""

    if tool_name == "Write":
        # 신규 파일 생성(순증)은 통과, 기존 파일 덮어쓰기는 차단.
        return _path_exists(file_path)

    if tool_name == "Edit":
        old = tool_input.get("old_string")
        new = tool_input.get("new_string")
        if old is None or new is None:
            return True  # 예상과 다른 payload — 안전하게 차단 방향으로
        return not is_pure_insertion(old, new)

    if tool_name == "MultiEdit":
        edits = tool_input.get("edits")
        if not isinstance(edits, list) or not edits:
            # 이 Claude Code 버전(2.1.220)은 MultiEdit을 permission 엔진이
            # "알려진 툴 아님"으로 취급한다(17g 조사) — 실제 payload 형태를
            # 라이브로 확인하지 못했다. 형태를 신뢰할 수 없으므로 fail-open.
            return False
        for edit in edits:
            if not isinstance(edit, dict):
                return False  # 예상과 다른 형태 — fail-open(미검증 경로)
            old = edit.get("old_string")
            new = edit.get("new_string")
            if old is None or new is None or not is_pure_insertion(old, new):
                return True
        return False

    return False  # 알 수 없는 tool_name -> fail-open


def should_block(agent_type: object, tool_name: str, tool_input: dict) -> bool:
    if agent_type != "coder":
        return False
    file_path = tool_input.get("file_path") or ""
    if not is_test_path(file_path):
        return False
    return touches_existing_assertion(tool_name, tool_input)


def _force_utf8() -> None:
    """cp949 콘솔에서 em-dash 등 출력 시 죽는 것을 방지
    (gate_spec_freeze.py와 동일한 이유 — 2026-07-21에 실제로 겪은 버그)."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, OSError):
            pass


def _stderr(msg: str) -> None:
    _force_utf8()
    print(msg, file=sys.stderr)


def run_hook() -> int:
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8", errors="replace"))
    except (json.JSONDecodeError, OSError, ValueError):
        return 0  # 파싱 실패는 이 게이트의 책임이 아니다 — fail-open

    agent_type = payload.get("agent_type")  # 메인 세션이면 키 자체가 없다(None)
    tool_name = payload.get("tool_name") or ""
    tool_input = payload.get("tool_input") or {}
    file_path = tool_input.get("file_path") or ""

    if should_block(agent_type, tool_name, tool_input):
        _stderr(
            f"[coder 테스트 게이트] coder 역할이 '{file_path}'의 **기존 단언**을 "
            f"건드리려 했다 — 차단(ADR-0011 결정 3).\n"
            f"허용: 신규 테스트 파일 추가, 기존 파일에 새 내용만 덧붙이는 편집"
            f"(test-after 영역, 순증만).\n"
            f"금지: 기존 단언의 수정·삭제·완화. 이게 그 경우라면 고치지 말고 "
            f"근거(RQ 인용)와 함께 보고하라 — 계속 진행하려면 이 편집이 왜 "
            f"'순증'인지부터 확인할 것.\n"
            f"주의: 이 게이트는 Write/Edit/MultiEdit 경로만 막는다 — Bash 경유 "
            f"쓰기는 evaluator 사후 diff 검출이 담당한다(원장 17f)."
        )
        return 2
    return 0


def run_selftest() -> int:
    global ROOT  # 아래에서 임시 디렉토리 검증을 위해 일시 교체했다 복원한다
    failures: list[str] = []

    def check(name: str, actual, expected) -> None:
        if actual != expected:
            failures.append(f"  {name}: expected {expected!r}, got {actual!r}")

    # --- is_test_path ---
    for path, expected in [
        ("tests/unit/rq-12.test.ts", True),
        ("tests/integration/rq-04.test.ts", True),
        ("test/legacy.test.ts", True),
        ("__tests__/x.test.ts", True),
        ("src/server/index.ts", False),
        ("harness/progress.md", False),
        ("", False),
        ("tests", True),
    ]:
        check(f"is_test_path({path!r})", is_test_path(path), expected)

    check("백슬래시 경로", is_test_path(r"tests\unit\rq-12.test.ts"), True)
    check(
        "절대 경로(프로젝트 내)",
        is_test_path(str(ROOT / "tests" / "unit" / "a.test.ts")),
        True,
    )
    check(
        "절대 경로(프로젝트 밖)",
        is_test_path(str(Path.home() / "tests" / "x.test.ts")),
        False,
    )

    # --- is_pure_insertion ---
    check("old가 new에 포함 -> 순수 삽입", is_pure_insertion("line three", "line three\nline four"), True)
    check("old가 new와 다름(치환) -> 순수 삽입 아님", is_pure_insertion("line two", "line TWO"), False)
    check("필드 누락 -> 순수 삽입 아님(안전 방향)", is_pure_insertion(None, "x"), False)

    # --- touches_existing_assertion: 도구별 판정 ---
    check(
        "Write + 신규 파일(존재하지 않음) -> 접촉 아님",
        touches_existing_assertion("Write", {"file_path": str(ROOT / "tests" / "__does_not_exist__.test.ts")}),
        False,
    )
    check(
        "Write + 기존 파일(존재함, 예: 이 hook 스크립트 자체) -> 접촉",
        touches_existing_assertion("Write", {"file_path": __file__}),
        True,
    )
    check(
        "Edit + 순수 삽입 -> 접촉 아님",
        touches_existing_assertion(
            "Edit", {"file_path": "tests/unit/a.test.ts", "old_string": "a", "new_string": "a\nb"}
        ),
        False,
    )
    check(
        "Edit + 치환(삽입 아님) -> 접촉",
        touches_existing_assertion(
            "Edit", {"file_path": "tests/unit/a.test.ts", "old_string": "expect(x).toBe(1)", "new_string": "expect(x).toBe(2)"}
        ),
        True,
    )
    check(
        "MultiEdit + 전부 순수 삽입 -> 접촉 아님",
        touches_existing_assertion(
            "MultiEdit",
            {
                "file_path": "tests/unit/a.test.ts",
                "edits": [
                    {"old_string": "a", "new_string": "a\nb"},
                    {"old_string": "c", "new_string": "c\nd"},
                ],
            },
        ),
        False,
    )
    check(
        "MultiEdit + 일부가 치환 -> 접촉",
        touches_existing_assertion(
            "MultiEdit",
            {
                "file_path": "tests/unit/a.test.ts",
                "edits": [
                    {"old_string": "a", "new_string": "a\nb"},
                    {"old_string": "c", "new_string": "C"},
                ],
            },
        ),
        True,
    )
    check(
        "MultiEdit + edits 필드 없음(미검증 payload) -> fail-open",
        touches_existing_assertion("MultiEdit", {"file_path": "tests/unit/a.test.ts"}),
        False,
    )
    check(
        "알 수 없는 tool_name -> fail-open",
        touches_existing_assertion("NotARealTool", {"file_path": "tests/unit/a.test.ts"}),
        False,
    )

    # --- should_block: 역할별 대조(라이브 4케이스 실증 결과와 일치해야 한다) ---
    check(
        "coder가 tests/ 신규 파일 Write -> 통과(ADR-0011 순증 허용)",
        should_block("coder", "Write", {"file_path": str(ROOT / "tests" / "__does_not_exist__.test.ts")}),
        False,
    )
    # "기존 파일 Write(덮어쓰기)"는 tests/ 안에 실재하는 파일이 필요하다.
    # 저장소의 실제 tests/를 건드리지 않기 위해(CLAUDE.md: tests/ 수정 금지)
    # gate_spec_freeze.py의 selftest와 같은 방식으로 완전히 별도인 OS 임시
    # 디렉토리를 프로젝트 루트로 취급해(ROOT를 이 블록 동안만 일시 교체) 그
    # 안에서만 검증한다 — 실제 저장소 파일은 생성·삭제 대상이 되지 않는다.
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        # .resolve()가 필수다 — 실제 ROOT(모듈 상단)도 resolve()된 값이라,
        # 여기서 안 하면 Windows의 임시 경로 별칭(예: 8.3 short name)이 섞여
        # is_test_path 내부의 relative_to()가 어긋난다(실측으로 발견한 버그).
        fake_root = Path(d).resolve()
        fake_tests_dir = fake_root / "tests"
        fake_tests_dir.mkdir()
        existing_file = fake_tests_dir / "existing.test.ts"
        existing_file.write_text("placeholder", encoding="utf-8")

        real_root = ROOT
        ROOT = fake_root
        try:
            check(
                "coder가 tests/ 기존 파일 Write(덮어쓰기) -> 차단",
                should_block("coder", "Write", {"file_path": str(existing_file)}),
                True,
            )
        finally:
            ROOT = real_root
    check(
        "coder가 tests/ 기존 파일을 치환 Edit -> 차단",
        should_block(
            "coder",
            "Edit",
            {"file_path": "tests/unit/a.test.ts", "old_string": "expect(x).toBe(1)", "new_string": "expect(x).toBe(2)"},
        ),
        True,
    )
    check(
        "test-writer는 tests/ 무엇을 해도 통과(agent_type 불일치)",
        should_block(
            "test-writer",
            "Edit",
            {"file_path": "tests/unit/a.test.ts", "old_string": "expect(x).toBe(1)", "new_string": "expect(x).toBe(2)"},
        ),
        False,
    )
    check(
        "evaluator·reviewer는 tests/에 프로브를 만들 수 있으므로 반드시 통과해야 한다",
        should_block("evaluator", "Write", {"file_path": str(ROOT / "tests" / "__probe__.test.ts")}),
        False,
    )
    check(
        "agent_type 없음(메인 세션)은 통과 — fail-open",
        should_block(None, "Write", {"file_path": str(ROOT / "tests" / "__probe__.test.ts")}),
        False,
    )
    check(
        "coder라도 src/는 통과",
        should_block("coder", "Write", {"file_path": "src/server/index.ts"}),
        False,
    )

    # --- 출력 인코딩이 죽지 않는가 ---
    try:
        _stderr("[selftest] em-dash — 확인용 메시지")
    except UnicodeEncodeError as exc:
        failures.append(f"  출력 인코딩 실패: {exc}")

    if failures:
        _stderr("[selftest] 실패 %d건:\n%s" % (len(failures), "\n".join(failures)))
        return 1
    print("[selftest] 통과.")
    return 0


def main() -> None:
    _force_utf8()
    argv = sys.argv[1:]
    if not argv:
        sys.exit(run_hook())
    if argv[0] == "--selftest":
        sys.exit(run_selftest())
    _stderr(f"알 수 없는 모드: {argv[0]}\n{__doc__}")
    sys.exit(64)


if __name__ == "__main__":
    main()
