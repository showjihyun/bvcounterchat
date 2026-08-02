#!/usr/bin/env python3
r"""트리거 발화 검출기 — 이월 행의 착수 조건이 왔는데 아무도 모르는 것을 막는다.

ADR-0012는 minor를 원장으로 이월하는 정책을 세우면서 그 안전성이 **원장
무결성에 정비례**한다고 적었고, 조건 1이 이월 행에 **착수 트리거**를 필수로
요구한다. 그런데 트리거를 발화시키는 것이 **사람의 기억뿐**이다.

## 세 번 조용히 미발화했다 (전부 실측)

  - **26af** — 트리거가 "`requirements.md`의 수치를 바꾸는 다음 PR"이었다. PR #38이
    정확히 그 행위를 했고 26af가 이미 ⬜로 등재돼 있었는데도 ADR-0007 미러 표가
    낡은 채 커밋됐다. **1차 독립 평가도 못 잡았고** 델타 재리뷰의 사람 눈이 잡았다.
  - **26x** — 트리거가 "26s 실행 라운드"였다. 그 라운드가 왔고 지나갔다.
  - **26ae·26ak** — 트리거가 "다음 라운드의 ADR-0012 조건 2 확인 시점"이었다.
    PR #39가 완료 행 2건을 기록하면서 그 확인을 빼먹었고 리뷰가 blocker로 잡았다.

셋 다 원인이 같다: **도래는 보장되지만 그것을 알려 주는 기계가 없다.**

## 이 검출기가 하는 일 — 그리고 하지 않는 일

⬜ 행의 **참조 파일 열**에서 경로를 뽑아 `경로 → [행 ID]` 지도를 만들고, 이 PR이
바꾼 경로가 걸리면 **그 행 ID를 경고로 출력**한다. 트리거 문면은 산문이라 기계가
읽을 수 없지만, **참조 파일은 구조화돼 있다** — 그 행이 손대야 할 파일을 지금
누가 손대고 있다면 그 행을 한 번 읽어 볼 값이 있다.

**절대 실패로 만들지 않는다(항상 exit 0).** 참조 파일 일치는 트리거 발화의
근사일 뿐이라 소음이 필연이다. 실패로 만들면 사람이 게이트를 꺼 버린다 —
이 저장소가 "센서가 죽는 가장 흔한 경로"로 이미 기록한 것이다.

세 미발화 중 **26af와 26x는 이 검출기로 잡혔을 것이다**(둘 다 참조 파일이
그 라운드가 바꾼 파일을 가리킨다). 26ae·26ak는 못 잡는다 — 그 트리거는 파일이
아니라 **행위**(조건 2 확인)라서다. 그래서 ADR-0012 조건 1에 "등재 행 ID를
가리켜라"를 더하는 것이 함께 필요하다(원장 26x).

## 한계 — 통과가 무엇을 증명하지 않는가

  - 참조 파일이 비었거나 파일이 아닌 행(예: "다음 라운드")은 **보이지 않는다**.
  - `harness/progress.md` 자기 참조는 제외한다 — 거의 모든 행이 그것을 가리켜
    경고가 무의미해진다.
  - 경고가 없다는 것은 "집을 이월이 없다"가 아니라 "**파일로 이어진 것이
    없다**"는 뜻이다.

실행 모드
---------
  --check-paths [P...]  주어진 경로(없으면 stdin에서 줄 단위)와 겹치는 ⬜ 행을
                        경고로 출력. **항상 exit 0.**
  --selftest            내장 검증.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
LEDGER = ROOT / "harness" / "progress.md"

CELL_SPLIT = re.compile(r"(?<!\\)\|")
# 참조 파일 열에서 경로처럼 보이는 것. 백틱 안이 대부분이고, 확장자나
# 디렉터리 구분자가 있어야 경로로 인정한다("브랜치"·"원장 26s" 같은 값 제외).
PATH_TOKEN = re.compile(r"`([^`]+)`")
LOOKS_LIKE_PATH = re.compile(r"^[\w./@-]+/[\w./@-]+$|\.[a-z]{2,4}$")
STATUS_INDEX = 4
REF_INDEX = 5
SELF_REF = "harness/progress.md"


def _force_utf8() -> None:
    """stdout·stderr를 UTF-8로 고정.

    Windows 한국어 로케일의 기본 인코딩(cp949)에서 한글·em-dash를 출력하면
    UnicodeEncodeError로 죽는다. 게이트가 원장과 무관한 이유로 죽으면 CI는
    "게이트 실패"로 보고하고 사람은 게이트를 꺼 버린다.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, OSError):
            pass


def _stderr(msg: str) -> None:
    _force_utf8()
    print(msg, file=sys.stderr)


def normalize(path: str) -> str:
    """경로를 비교 가능한 형태로. **`lstrip("./")`를 쓰지 않는다** — 그것은 문자
    집합을 벗기므로 `.claude/hooks/x.py`가 `claude/hooks/x.py`가 된다(실측: 첫
    실행 출력이 그랬다). 색인과 질의가 같은 함수를 타 매칭은 성립하지만, 진단이
    존재하지 않는 경로를 가리키고 `.github/`와 `github/`가 충돌할 여지가 남는다.
    선행 `./`만 벗긴다.
    """
    p = path.replace("\\", "/").strip()
    while p.startswith("./"):
        p = p[2:]
    return p


def open_rows(text: str) -> dict[str, set[str]]:
    """⬜ 행의 `참조 파일` 열에서 경로를 뽑아 `경로 → {행 ID}`."""
    index: dict[str, set[str]] = {}
    for line in text.split("\n"):
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in CELL_SPLIT.split(line)]
        if len(cells) <= REF_INDEX or cells[1] == "순번":
            continue
        if not cells[STATUS_INDEX].startswith("⬜"):
            continue
        for token in PATH_TOKEN.findall(cells[REF_INDEX]):
            # `path:123`·`path` `symbol` 형태에서 경로만 남긴다.
            cand = normalize(token.split()[0].split(":")[0])
            if not LOOKS_LIKE_PATH.search(cand) or cand == SELF_REF:
                continue
            index.setdefault(cand, set()).add(cells[1])
    return index


def due_rows(index: dict[str, set[str]], changed: list[str]) -> dict[str, set[str]]:
    """변경 경로와 겹치는 행. 디렉터리 접두 일치도 인정한다."""
    hit: dict[str, set[str]] = {}
    for raw in changed:
        path = normalize(raw)
        if not path:
            continue
        for ref, ids in index.items():
            if path == ref or path.startswith(ref.rstrip("/") + "/"):
                hit.setdefault(ref, set()).update(ids)
    return hit


def run_check_paths(paths: list[str]) -> int:
    """**항상 0을 돌려준다.** 근사 검출이라 실패로 만들면 게이트가 꺼진다."""
    if not paths:
        try:
            paths = [l.strip() for l in
                     sys.stdin.buffer.read().decode("utf-8", errors="replace").splitlines()
                     if l.strip()]
        except (OSError, ValueError):
            paths = []
    if not LEDGER.exists() or not paths:
        return 0
    hit = due_rows(open_rows(LEDGER.read_text(encoding="utf-8")), paths)
    if not hit:
        print("[트리거 검출기] 변경 경로와 이어진 ⬜ 행 없음.")
        return 0
    lines = ["  %s → %s" % (ref, " ".join(sorted(ids)))
             for ref, ids in sorted(hit.items())]
    print(
        "[트리거 검출기] 이 변경이 건드리는 파일을 참조하는 ⬜ 행이 있다 "
        "— 착수 트리거가 왔는지 확인하라(경고, 실패 아님):\n%s\n"
        "이 저장소에서 이월 트리거가 **세 번** 조용히 미발화했다(26af·26x·26ae/26ak)."
        % "\n".join(lines)
    )
    return 0


def run_selftest() -> int:
    failed: list[str] = []
    sample = "\n".join([
        "| 순번 | 작업 | 관련 RQ/ADR | 상태 | 참조 파일 | 비고 |",
        "|---|---|---|---|---|---|",
        "| 26af | **미러** | 하네스 | ⬜ | `harness/evals/golden/track-a.jsonl`, "
        "`harness/adr/0007-map.md` | x |",
        "| 26x | **트리거** | ADR-0012 | ⬜ | `harness/progress.md` 26s | x |",
        "| 26s | **완료** | RQ-31 | ✅ | `src/shared/constants.ts` | x |",
        "| 22h | **열림** | RQ-43 | ⬜ | `src/server/rooms/GameRoom.ts` "
        "`promoteWaitingSpectator` | x |",
        "| 23 | **단계** | RQ-40 | ⬜ |  | x |",
    ])
    index = open_rows(sample)

    checks = [
        ("⬜ 행의 참조 경로를 잡는다", "harness/adr/0007-map.md" in index),
        ("한 행의 경로 여럿을 전부 잡는다",
         "harness/evals/golden/track-a.jsonl" in index),
        ("✅ 행은 보지 않는다", "src/shared/constants.ts" not in index),
        ("원장 자기 참조는 제외한다", SELF_REF not in index),
        ("참조가 빈 행은 건너뛴다", all("23" not in v for v in index.values())),
        ("경로 뒤 심볼명을 떼어낸다",
         "src/server/rooms/GameRoom.ts" in index),
    ]
    for name, ok in checks:
        if not ok:
            failed.append("색인 — %s" % name)

    hit = due_rows(index, ["harness/adr/0007-map.md"])
    if hit.get("harness/adr/0007-map.md") != {"26af"}:
        failed.append("일치 — 정확 경로에서 행 ID를 못 냈다: %r" % hit)

    # 정규화 — 선행 점을 벗기면 진단이 없는 경로를 가리키고 `.github/`가
    # `github/`와 충돌한다(첫 실행 출력이 실제로 `claude/hooks/`였다).
    for raw, want in ((".claude/hooks/x.py", ".claude/hooks/x.py"),
                      ("./src/a.ts", "src/a.ts"),
                      (r".github\workflows\ci.yml", ".github/workflows/ci.yml"),
                      ("./././b.ts", "b.ts")):
        if normalize(raw) != want:
            failed.append("정규화 — %r → %r (기대 %r)" % (raw, normalize(raw), want))
    dot_index = open_rows("\n".join([
        "| 순번 | 작업 | 관련 | 상태 | 참조 파일 | 비고 |",
        "|---|---|---|---|---|---|",
        "| 17i | **x** | 하네스 | ⬜ | `.claude/hooks/gate_a.py` | x |",
    ]))
    if ".claude/hooks/gate_a.py" not in dot_index:
        failed.append("정규화 — 색인이 선행 점을 잃었다: %r" % list(dot_index))
    if due_rows(dot_index, ["claude/hooks/gate_a.py"]):
        failed.append("정규화 — 점 없는 경로가 점 있는 참조에 잘못 걸린다")
    if due_rows(index, ["README.md"]):
        failed.append("일치 — 무관한 경로에 반응했다")
    if not due_rows(index, ["src/server/rooms/GameRoom.ts"]):
        failed.append("일치 — 심볼이 붙은 참조를 못 맞췄다")

    # **실패로 만들지 않는다**가 이 게이트의 계약이다.
    # 계약 검사가 찍는 출력은 삼킨다 — selftest 출력에 섞이면 CI 로그에서
    # 진짜 결과가 묻힌다.
    import contextlib
    import io as _io
    for paths in (["harness/adr/0007-map.md"], ["없는/경로.md"]):
        with contextlib.redirect_stdout(_io.StringIO()):
            rc = run_check_paths(list(paths))
        if rc != 0:
            failed.append("계약 위반 — exit 0이 아니다: %r" % (paths,))

    if failed:
        _stderr("[트리거 검출기 selftest] 실패 %d건:\n  %s"
                % (len(failed), "\n  ".join(failed)))
        return 1
    # 요약은 **실제 단언 수**를 말해야 한다 — `sensor-catalog.md`가 이 문자열을
    # 그대로 인용하므로 정본이 적게 세면 문서도 적게 센다(리뷰 minor).
    print("[트리거 검출기 selftest] 통과 — 색인 %d건·정규화 6건·일치 3건·계약 2건 확인."
          % len(checks))
    return 0


def main() -> None:
    _force_utf8()
    argv = sys.argv[1:]
    if not argv:
        _stderr("이 검출기는 PreToolUse 훅이 아니다 — 변경 경로 목록이 필요하다."
                "\n%s" % __doc__)
        sys.exit(64)
    mode = argv[0]
    if mode == "--check-paths":
        sys.exit(run_check_paths(argv[1:]))
    if mode == "--selftest":
        sys.exit(run_selftest())
    _stderr("알 수 없는 모드: %s\n%s" % (mode, __doc__))
    sys.exit(64)


if __name__ == "__main__":
    main()
