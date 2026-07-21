#!/usr/bin/env python3
"""스펙 동결 게이트 — 판정 로직의 단일 진실 공급원.

Deep Interview가 끝나기 전(requirements.md에 🟡 PENDING이 남아 있는 동안)
구현 산출물(src/, tests/ 등)의 생성·수정을 차단한다.

원칙(CLAUDE.md): "반드시"는 hook·CI로 강제한다. 스펙이 모호한 상태의 구현은
전부 추측이고, 추측 구현은 인터뷰 후 재작업이 된다.

**이 파일 하나가 모든 실행 지점의 판정을 담당한다.** hook과 CI가 각자
정규식을 들고 있으면 언젠가 어긋나고, 로컬에선 막히는데 CI는 통과하는(또는
반대) 게이트는 신뢰를 잃어 곧 무시된다. 그래서 CI(ci.yml)도 grep을 쓰지 않고
이 스크립트의 --check-paths를 호출한다.

실행 모드
---------
  (stdin에 JSON)      PreToolUse hook. exit 2 = 도구 호출 차단.
  --check             현재 PENDING 건수 보고. 🟡가 있으면 exit 1.
  --check-paths P...  주어진 경로 중 구현 파일이 있고 🟡도 있으면 exit 1. (CI용)
  --selftest          내장 검증. 게이트 자체가 고장 났는지 확인한다.

exit 2(hook)의 stderr 메시지는 에이전트가 읽고 자기 교정하는 것이 목적이므로
"무엇이 막혔는지 + 어떻게 푸는지"를 함께 담는다.
이 hook은 메인 세션뿐 아니라 서브 에이전트(coder·test-writer)에도 적용된다.
"""
import json
import sys
from pathlib import Path

# 구현 산출물로 간주하는 최상위 디렉토리.
# 프로젝트 스캐폴딩(로드맵 1단계)에서 실제 레이아웃이 정해지면 여기를 갱신한다.
# 넓게 잡는 쪽이 안전하다 — 빠뜨린 디렉토리는 게이트에 뚫린 구멍이 된다.
BLOCKED_TOP_DIRS = {
    "src", "tests", "test", "__tests__",
    "client", "server", "shared", "packages",
}

ROOT = Path(__file__).resolve().parent.parent.parent
SPEC = ROOT / "harness" / "specs" / "requirements.md"


def count_pending(spec_path: Path = SPEC) -> int:
    """requirements.md의 미결(🟡) RQ 건수.

    RQ 항목 줄만 센다 — 문서 상단 범례("상태 기호: ✅확정 / 🟡PENDING")나
    개정 이력의 🟡까지 세면 영구히 차단되는 게이트가 된다.
    """
    if not spec_path.exists():
        return 0  # 스펙 파일 부재는 다른 문제 — 이 게이트가 판단하지 않는다
    return sum(
        1
        for line in spec_path.read_text(encoding="utf-8").splitlines()
        if line.lstrip().startswith("- **RQ") and "🟡" in line
    )


def is_implementation_path(path_str: str) -> bool:
    """이 경로가 구현 산출물인가. 경로 구분자·상대/절대 표기에 무관하게 판정."""
    if not path_str:
        return False
    p = Path(path_str)
    try:
        rel = p.resolve().relative_to(ROOT) if p.is_absolute() else p
    except (ValueError, OSError):
        return False  # 프로젝트 밖 경로는 이 게이트의 관할이 아니다
    parts = [seg for seg in rel.parts if seg not in (".", "")]
    return bool(parts) and parts[0] in BLOCKED_TOP_DIRS


def _message(pending: int, target: str) -> str:
    return (
        f"[스펙 동결 게이트] Deep Interview 미완료 — "
        f"harness/specs/requirements.md에 PENDING(🟡) {pending}건이 남아 있어 "
        f"'{target}' 수정을 차단한다.\n"
        f"해결: harness/specs/interview/question-bank.md로 인터뷰를 완료하고, "
        f"답변을 answers.md에 기록한 뒤 해당 RQ를 EARS 문장으로 고쳐 ✅로 바꿔라. "
        f"스펙이 모호한 상태의 구현은 추측이며, 추측은 재작업이 된다.\n"
        f"확인: python .claude/hooks/gate_spec_freeze.py --check"
    )


def _force_utf8() -> None:
    """stdout·stderr를 UTF-8로 고정.

    Windows 한국어 로케일의 기본 콘솔 인코딩은 cp949라서, 한글이나 em-dash(—)를
    그대로 출력하면 UnicodeEncodeError로 프로세스가 죽는다. 게이트가 스펙과
    무관한 이유로 죽으면 CI는 그것을 "게이트 실패"로 보고하고, 사람은 원인을
    찾다가 게이트를 꺼버린다 — 센서가 죽는 가장 흔한 경로다.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, OSError):
            pass  # 재설정 실패해도 메시지는 내보낸다


def _stderr(msg: str) -> None:
    _force_utf8()
    print(msg, file=sys.stderr)


def run_hook() -> int:
    """PreToolUse hook 모드. stdin의 도구 호출 페이로드를 검사한다."""
    # stdin을 바이트로 읽어 UTF-8로 명시 디코딩한다. Windows 한국어 로케일에서
    # 기본 인코딩(cp949)에 의존하면 한글 포함 페이로드가 디코딩 실패로
    # 게이트를 우회(fail-open)하게 된다.
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8", errors="replace"))
    except (json.JSONDecodeError, OSError, ValueError):
        return 0

    file_path = (payload.get("tool_input") or {}).get("file_path") or ""
    if not is_implementation_path(file_path):
        return 0

    pending = count_pending()
    if pending > 0:
        _stderr(_message(pending, file_path))
        return 2
    return 0


def run_check() -> int:
    """현재 동결 상태 보고. 사람과 CI 양쪽이 쓴다."""
    pending = count_pending()
    if pending > 0:
        _stderr(
            f"[스펙 동결 게이트] PENDING(🟡) {pending}건 — 구현 착수 불가.\n"
            f"harness/specs/interview/question-bank.md로 인터뷰를 완료하라."
        )
        return 1
    print("[스펙 동결 게이트] PENDING 0건 — 구현 착수 가능.")
    return 0


def run_check_paths(paths: list[str]) -> int:
    """CI용. 변경된 경로 목록 중 구현 파일이 있고 🟡도 있으면 실패.

    인자가 없으면 stdin에서 한 줄에 하나씩 읽는다 — `git diff --name-only | ...`
    파이프를 그대로 받기 위함이다. xargs를 거치면 파일 수가 많을 때 여러 번
    분할 호출되어 종료 코드 의미가 흐려지므로 파이프를 직접 받는다.
    """
    if not paths:
        try:
            paths = [
                line.strip()
                for line in sys.stdin.buffer.read().decode("utf-8", errors="replace").splitlines()
                if line.strip()
            ]
        except (OSError, ValueError):
            paths = []
    impl = [p for p in paths if is_implementation_path(p)]
    if not impl:
        return 0
    pending = count_pending()
    if pending > 0:
        _stderr(_message(pending, ", ".join(impl[:5]) + ("..." if len(impl) > 5 else "")))
        return 1
    return 0


def run_selftest() -> int:
    """게이트 자체의 검증. 고장 난 센서는 없는 센서보다 나쁘다 —
    통과하고 있다고 착각하게 만들기 때문이다."""
    import tempfile

    failures = []

    def check(name: str, actual, expected) -> None:
        if actual != expected:
            failures.append(f"  {name}: expected {expected!r}, got {actual!r}")

    # --- count_pending: RQ 줄만 세는가 ---
    with tempfile.TemporaryDirectory() as d:
        spec = Path(d) / "requirements.md"

        spec.write_text(
            "> 상태 기호: ✅확정 / 🟡PENDING(구현 착수 금지)\n"
            "> | v1.0 | RQ-90~95 확정(🟡→✅) |\n"
            "- **RQ-01** ✅ 확정된 항목\n"
            "`docs/req/`가 정하지 않아 🟡였던 항목들\n",
            encoding="utf-8",
        )
        check("범례·이력·산문의 🟡는 세지 않는다", count_pending(spec), 0)

        spec.write_text(
            "> 상태 기호: ✅확정 / 🟡PENDING\n"
            "- **RQ-01** ✅ 확정\n"
            "- **RQ-90** 🟡 무기 데미지 수치\n"
            "  - **RQ-91** 🟡 들여쓰기된 항목도 센다\n",
            encoding="utf-8",
        )
        check("RQ 줄의 🟡는 센다", count_pending(spec), 2)

        check("스펙 파일 부재는 0", count_pending(Path(d) / "없음.md"), 0)

    # --- is_implementation_path ---
    for path, expected in [
        ("src/game/tick.ts", True),
        ("tests/integration/rq-12.test.ts", True),
        ("server/room.ts", True),
        ("harness/specs/requirements.md", False),
        ("harness/adr/0001-client-rendering-stack.md", False),
        ("CLAUDE.md", False),
        ("docs/req/01_Project_Overview.md", False),
        ("", False),
        ("src", True),
    ]:
        check(f"is_implementation_path({path!r})", is_implementation_path(path), expected)

    # 경로 구분자 무관 — Windows 백슬래시로 들어와도 같은 판정이어야 한다
    check("백슬래시 경로", is_implementation_path(r"src\game\tick.ts"), True)
    # 절대 경로 — 실제 훅 페이로드는 절대 경로로 온다
    check("절대 경로(프로젝트 내)", is_implementation_path(str(ROOT / "src" / "a.ts")), True)
    check("절대 경로(프로젝트 밖)", is_implementation_path(str(Path(tempfile.gettempdir()) / "x.ts")), False)

    # --- run_check_paths: 문서만 바뀐 PR은 🟡가 있어도 통과해야 한다 ---
    real_pending = count_pending()
    check("문서 전용 변경은 통과", run_check_paths(["CLAUDE.md", "harness/README.md"]), 0)
    if real_pending == 0:
        check("🟡 0건이면 구현 변경도 통과", run_check_paths(["src/a.ts"]), 0)

    # --- 출력 경로가 인코딩으로 죽지 않는가 ---
    # 2026-07-21 실제로 여기서 죽었다: cp949 stdout + em-dash(—) → UnicodeEncodeError.
    # 게이트가 스펙과 무관한 이유로 죽으면 CI는 "게이트 실패"로 보고한다.
    try:
        check("run_check 출력이 인코딩으로 죽지 않는다", run_check(), 0 if real_pending == 0 else 1)
        _message(3, "src/a.ts")  # 한글·em-dash 포함 메시지 생성 자체도 검증
    except UnicodeEncodeError as exc:
        failures.append(f"  출력 인코딩 실패: {exc}")

    if failures:
        _stderr("[selftest] 실패 %d건:\n%s" % (len(failures), "\n".join(failures)))
        return 1
    print(f"[selftest] 통과. 현재 스펙 PENDING: {real_pending}건")
    return 0


def main() -> None:
    _force_utf8()
    argv = sys.argv[1:]
    if not argv:
        sys.exit(run_hook())
    mode = argv[0]
    if mode == "--check":
        sys.exit(run_check())
    if mode == "--check-paths":
        sys.exit(run_check_paths(argv[1:]))
    if mode == "--selftest":
        sys.exit(run_selftest())
    _stderr(f"알 수 없는 모드: {mode}\n{__doc__}")
    sys.exit(64)


if __name__ == "__main__":
    main()
