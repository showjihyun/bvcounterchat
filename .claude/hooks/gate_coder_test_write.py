#!/usr/bin/env python3
"""coder 역할 tests/ 쓰기 차단 게이트.

원장 17f(파이프라인 무결성) 후속. `.claude/agents/coder.md`가 "테스트 파일을
절대 수정하지 않는다"를 프롬프트로만 강제하고 있었다 — coder의 `tools:`에
`Write`·`Edit`·`Bash`가 있어 도구 수준에서는 막히지 않았다. 이 hook은 그
프롬프트 강제의 **일부**(Write/Edit/MultiEdit 경유만)를 결정론적 게이트로
승격한다.

**어떻게 "coder"를 식별하는가**: PreToolUse hook의 stdin JSON에 서브에이전트
호출 시 `agent_type` 필드가 실려 온다 — 값은 `.claude/agents/<name>.md`
frontmatter의 `name:`과 정확히 일치한다(Claude Code 2.1.220 실측,
`_workspace/debt/01_report.md` 참고). 메인 세션 호출에는 이 키 자체가 없다.
`agent_type`이 없거나 `"coder"`가 아니면(메인 세션·test-writer·evaluator·
reviewer 전부 포함) 조용히 통과시킨다(fail-open) — 이 필드가 향후 Claude
Code 버전에서 사라지거나 이름이 바뀌어도, 정당한 작업을 막는 방향이 아니라
가장 안전한 방향(차단 안 함)으로 실패한다.

**정직하게 남는 구멍**: `matcher`는 `Write|Edit|MultiEdit`뿐이다. coder가
`Bash`(예: 셸 리다이렉트·python heredoc)로 `tests/`에 쓰면 이 hook은 아예
호출되지 않는다 — Bash는 매처에 없다. 이 경로는 기존 evaluator 사후 diff
검출(`03_evaluator_report.md` 검증 항목 5, SHA 기준점 사슬)이 계속 맡는다.
이 hook은 "coder가 Write/Edit 툴로 실수하거나 우회 없이 시도하는" 가장
흔한 경로만 결정론적으로 막는다 — 완전한 강제가 아니다.

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


def is_test_path(path_str: str) -> bool:
    """이 경로가 테스트 디렉토리 안인가. 경로 구분자·상대/절대 표기에 무관하게
    판정한다 — gate_spec_freeze.py의 is_implementation_path와 동일한 이유로
    백슬래시를 먼저 정규화한다(Windows 훅 payload는 절대 경로 백슬래시로 온다)."""
    if not path_str:
        return False
    p = Path(path_str.replace("\\", "/"))
    try:
        rel = p.resolve().relative_to(ROOT) if p.is_absolute() else p
    except (ValueError, OSError):
        return False  # 프로젝트 밖 경로는 이 게이트의 관할이 아니다
    parts = [seg for seg in rel.parts if seg not in (".", "")]
    return bool(parts) and parts[0] in TEST_TOP_DIRS


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


def should_block(agent_type: object, file_path: str) -> bool:
    return agent_type == "coder" and is_test_path(file_path)


def run_hook() -> int:
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8", errors="replace"))
    except (json.JSONDecodeError, OSError, ValueError):
        return 0  # 파싱 실패는 이 게이트의 책임이 아니다 — fail-open

    agent_type = payload.get("agent_type")  # 메인 세션이면 키 자체가 없다(None)
    file_path = (payload.get("tool_input") or {}).get("file_path") or ""

    if should_block(agent_type, file_path):
        _stderr(
            f"[coder 테스트 쓰기 게이트] coder 역할이 '{file_path}'(tests/)를 "
            f"수정하려 했다 — 차단.\n"
            f".claude/agents/coder.md: \"테스트 파일을 절대 수정하지 않는다. "
            f"테스트가 틀렸다고 판단되면 고치지 말고 근거(RQ 인용)와 함께 "
            f"보고하라.\"\n"
            f"주의: 이 게이트는 Write/Edit/MultiEdit 경로만 막는다 — Bash 경유 "
            f"쓰기는 evaluator 사후 diff 검출이 담당한다(원장 17f)."
        )
        return 2
    return 0


def run_selftest() -> int:
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

    # --- should_block: 세 역할 대조(라이브 실증 결과와 일치해야 한다) ---
    check("coder가 tests/를 쓰면 차단", should_block("coder", "tests/unit/a.test.ts"), True)
    check(
        "test-writer는 tests/를 써도 통과",
        should_block("test-writer", "tests/unit/a.test.ts"),
        False,
    )
    check(
        "evaluator는 tests/를 건드려도 통과(읽기 전용 역할이라 실제로는 안 씀)",
        should_block("evaluator", "tests/unit/a.test.ts"),
        False,
    )
    check(
        "agent_type 없음(메인 세션)은 통과 — fail-open",
        should_block(None, "tests/unit/a.test.ts"),
        False,
    )
    check("coder라도 src/는 통과", should_block("coder", "src/server/index.ts"), False)

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
