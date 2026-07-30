#!/usr/bin/env python3
"""원장 표 무결성 게이트 — `harness/progress.md`의 GFM 표가 깨지는 것을 막는다.

원장은 이 프로젝트의 진행 기록이자 이월 항목의 유일한 보관소다(ADR-0012:
"이월을 원장으로 몰아주는 정책의 안전성은 원장 무결성에 정비례한다"). 그런데
표가 깨져도 지금까지 **아무것도 실패하지 않았다** — 2026-07-30 이전까지 7개
행이 깨진 채로 CI를 통과했다.

무엇이 깨졌었나(실측):
  - `28a` — semver 범위 인용의 맨 파이프 8쌍. GitHub 렌더에서 비고가
    `engines`를 인용하는 지점에서 **잘려 사라졌다**(손실량 최대).
  - `22f` — JS 논리 OR 1쌍. `jump: next.jump` 지점에서 잘렸다.
  - `22h`~`22l` — 참조 파일 열이 통째로 빠져 비고가 그 칸으로 밀렸다.
  - `26l` — 이스케이프된 파이프가 **제목 열**(상태 열 앞)에 있어, 열 인덱스로
    세는 스크립트가 상태칸을 RQ 열로 읽었다. ⬜ 집계가 97로 나오고 참값은
    98이었다. 그 수치가 ADR-0012 조건 2의 재검토 임계를 가른다.

**왜 규율로는 안 되는가**: 이 결함은 파이프 문자를 타이핑하는 순간마다
재발한다. 2026-07-29 라운드에서 오케스트레이터가 절댓값 기호를 코드 스팬에
넣어 `26s` 행을 깨뜨렸다가 같은 커밋에서 고쳤다 — 같은 결함을 고치고 있던
바로 그 라운드에서다.

## 파이프를 셀 안에 넣는 정본 방법 — 백슬래시 **하나**

GitHub 실제 렌더러(`api.github.com/markdown`, `mode: gfm`)로 실측한 결과:

  | 표기            | 코드 스팬 안                          | 코드 스팬 밖 |
  |-----------------|---------------------------------------|--------------|
  | 맨 파이프       | 열 분리(파손) — 백틱까지 깨진다       | 열 분리(파손) |
  | 백슬래시 1개    | **정상**(렌더에 파이프만 남는다)      | **정상**      |
  | 백슬래시 2개    | 열은 유지되나 백슬래시가 **노출**된다 | 동일          |
  | `&#124;` 엔티티 | **디코딩 안 됨** — 리터럴이 보인다    | 정상          |

즉 **파이프 앞에 백슬래시 하나**가 정답이다. 원장 `26l`이 최초에 적은
"코드 스팬 안에서는 이중 백슬래시가 필요하다"와 `26ag`가 적은 "`&#124;`로
치환한다"는 **둘 다 거짓**이며 2026-07-30에 정정됐다.

## 이 게이트가 naive 분할을 쓰지 않는 이유

`awk -F'|'`는 이스케이프를 모른다. 그 방식으로 세면 이미 올바르게
이스케이프된 4개 행(`21a-2`·`22f`·`28a`·`22u`·`22z5`)을 **오탐**한다 —
실제로 그 오탐이 이 결함의 최초 진단을 틀리게 만들어 "12행이 깨졌다"는
잘못된 기록을 낳았다(참값은 7행). 그래서 이 게이트는 `(?<!\\)\|`로 나눈다.

## 한계 — 통과가 무엇을 증명하지 않는가

이 게이트는 **열 수와 상태 열 위치**만 본다. 셀 내용의 정확성(수치가 최신인가,
트리거가 유효한가)은 보지 않는다 — 그것은 사람과 리뷰의 몫이다.

실행 모드
---------
  (stdin에 JSON)   PreToolUse hook. exit 2 = 도구 호출 차단.
                   원장 경로일 때만 동작하고, **코드 스팬 안의 맨 파이프**만
                   본다(정상 셀 경계 파이프는 백틱 밖이라 오탐이 없다).
  --check          원장 전체 검사. 위반이 있으면 exit 1.
  --selftest       내장 검증. 게이트 자체가 고장 났는지 확인한다.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
LEDGER = ROOT / "harness" / "progress.md"

# 이스케이프되지 않은 파이프만 셀 구분자로 인정한다.
CELL_SPLIT = re.compile(r"(?<!\\)\|")
# 백틱 코드 스팬. 백틱 개수가 같은 쌍을 찾는다(``foo`` 형태도 포함).
CODE_SPAN = re.compile(r"(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)", re.DOTALL)

# `| 순번 | 작업 | ... |` 형태의 헤더와 `|---|---|` 구분선.
SEPARATOR_CELL = re.compile(r"^:?-{1,}:?$")

# 상태 열의 인덱스(CELL_SPLIT 결과 기준). 정상 행은
# ['', 순번, 작업, 관련RQ, 상태, 참조파일, 비고, ''] 로 8필드다.
STATUS_INDEX = 4


def _force_utf8() -> None:
    """stdout·stderr를 UTF-8로 고정.

    Windows 한국어 로케일의 기본 콘솔 인코딩은 cp949라서, 한글이나 em-dash(—)를
    그대로 출력하면 UnicodeEncodeError로 프로세스가 죽는다. 게이트가 원장과
    무관한 이유로 죽으면 CI는 그것을 "게이트 실패"로 보고하고, 사람은 원인을
    찾다가 게이트를 꺼버린다 — 센서가 죽는 가장 흔한 경로다.

    이 저장소는 이미 그 사고를 냈고(원장 26r blocker B4), 새 훅이 기존 구현을
    복사하지 않아 **재발한** 전례가 있다. 처음부터 넣는다.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, OSError):
            pass  # 재설정 실패해도 메시지는 내보낸다


def _stderr(msg: str) -> None:
    _force_utf8()
    print(msg, file=sys.stderr)


def split_cells(line: str) -> list[str]:
    """이스케이프-인식 셀 분할. GitHub 렌더러와 같은 판정을 낸다."""
    return [cell.strip() for cell in CELL_SPLIT.split(line.rstrip("\n"))]


def is_separator_row(cells: list[str]) -> bool:
    inner = [c for c in cells[1:-1]] if len(cells) > 2 else []
    return bool(inner) and all(SEPARATOR_CELL.match(c) for c in inner)


def bare_pipes_in_code_spans(text: str) -> list[str]:
    """코드 스팬 안의 **이스케이프되지 않은** 파이프를 담은 스팬 목록.

    정상적인 셀 경계 파이프는 백틱 **밖**에 있으므로 여기 걸리지 않는다.
    이 판정이 좁은 것은 의도다 — 훅은 편집을 막으므로 오탐 비용이 크다.
    """
    hits = []
    for match in CODE_SPAN.finditer(text):
        body = match.group(2)
        if CELL_SPLIT.search(body):
            hits.append(match.group(0))
    return hits


def check_text(text: str) -> tuple[list[str], list[str]]:
    """원장 본문을 검사해 (위반, 경고) 메시지 목록을 낸다.

    표마다 기대 열 수를 **그 표의 헤더에서 다시 읽는다** — 하드코딩하면
    새 표가 다른 열 수로 추가될 때 조용히 오탐한다.
    """
    violations: list[str] = []
    warnings: list[str] = []
    expected: int | None = None

    for lineno, raw in enumerate(text.split("\n"), 1):
        if not raw.startswith("|"):
            # 표 밖에 파이프가 있으면 표 판정 자체가 흔들린다. 현재 원장에는
            # 0건이고 펜스 코드 블록도 없지만, 생기면 알아야 한다.
            if "|" in raw:
                warnings.append(
                    f"  {lineno}행: 표 밖에 파이프가 있다 — 표 판정 전제가 깨질 수 있다"
                )
            continue

        cells = split_cells(raw)

        if is_separator_row(cells):
            continue

        # 헤더 행: 기대 열 수를 여기서 재설정한다.
        if len(cells) > 1 and cells[1] == "순번":
            expected = len(cells)
            continue

        if expected is None:
            warnings.append(f"  {lineno}행: 헤더보다 먼저 나온 표 행 — 건너뛴다")
            continue

        if len(cells) != expected:
            kind = "부족" if len(cells) < expected else "초과"
            row_id = cells[1] if len(cells) > 1 else "?"
            fix = (
                "참조 파일 열이 빠졌는지 확인하라(빈 칸이라도 파이프는 있어야 한다)"
                if kind == "부족"
                else "셀 안의 파이프 앞에 백슬래시 하나를 붙여라"
            )
            violations.append(
                f"  {lineno}행 [{row_id}] 열 수 {kind} — {len(cells)}개"
                f"(기대 {expected}개). {fix}"
            )
            continue

        # 열 수가 맞아도, 상태 열 **앞**에 이스케이프된 파이프가 있으면
        # 열 인덱스로 세는 다른 스크립트가 상태칸을 한 칸 밀려 읽는다.
        # `26l`이 그래서 ⬜ 집계를 97로 만들었다(참값 98).
        head = "|".join(cells[1:STATUS_INDEX])
        if "\\|" in head:
            row_id = cells[1] if len(cells) > 1 else "?"
            violations.append(
                f"  {lineno}행 [{row_id}] 상태 열 앞에 이스케이프된 파이프가 있다 — "
                f"열 인덱스로 세는 스크립트가 상태칸을 잘못 읽는다"
                f"(⬜/✅ 집계가 조용히 틀어진다). 그 파이프를 산문으로 바꿔라"
            )

    return violations, warnings


def run_check(ledger: Path = LEDGER) -> int:
    if not ledger.exists():
        _stderr(f"[원장 표 게이트] 원장을 찾을 수 없다: {ledger}")
        return 1
    violations, warnings = check_text(ledger.read_text(encoding="utf-8"))
    for warn in warnings:
        print(f"[원장 표 게이트] 경고:\n{warn}")
    if violations:
        _stderr(
            "[원장 표 게이트] 표 무결성 위반 %d건:\n%s\n"
            "파이프를 셀 안에 넣으려면 **백슬래시 하나**를 앞에 붙인다 — "
            "이중 백슬래시는 렌더에 백슬래시가 노출되고, `&#124;`는 코드 스팬 안에서 "
            "디코딩되지 않는다(2026-07-30 실측)."
            % (len(violations), "\n".join(violations))
        )
        return 1
    print("[원장 표 게이트] 위반 0건.")
    return 0


def run_hook() -> int:
    """PreToolUse hook. 원장을 쓰는 도구 호출에서 코드 스팬 안 맨 파이프를 막는다."""
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8", errors="replace"))
    except (json.JSONDecodeError, OSError, ValueError):
        return 0  # 파싱 실패는 이 게이트의 관할이 아니다

    tool_input = payload.get("tool_input") or {}
    file_path = (tool_input.get("file_path") or tool_input.get("path") or "").replace("\\", "/")
    if not file_path.endswith("harness/progress.md"):
        return 0

    # 새로 들어가는 텍스트만 본다. Write는 content, Edit는 new_string,
    # MultiEdit는 edits[].new_string.
    candidates: list[str] = []
    if isinstance(tool_input.get("content"), str):
        candidates.append(tool_input["content"])
    if isinstance(tool_input.get("new_string"), str):
        candidates.append(tool_input["new_string"])
    for edit in tool_input.get("edits") or []:
        if isinstance(edit, dict) and isinstance(edit.get("new_string"), str):
            candidates.append(edit["new_string"])

    hits: list[str] = []
    for text in candidates:
        hits.extend(bare_pipes_in_code_spans(text))
    if not hits:
        return 0

    sample = ", ".join(hits[:3]) + ("..." if len(hits) > 3 else "")
    _stderr(
        f"[원장 표 게이트] 코드 스팬 안에 이스케이프되지 않은 파이프가 있다: {sample}\n"
        f"GFM은 이것을 셀 구분자로 읽어 그 행의 비고가 렌더에서 잘려 사라진다 "
        f"(원장 28a·22f가 실제로 그렇게 깨져 있었다).\n"
        f"해결: 파이프 앞에 **백슬래시 하나**를 붙여라. 이중 백슬래시는 렌더에 "
        f"백슬래시가 노출되고, `&#124;`는 코드 스팬 안에서 디코딩되지 않는다.\n"
        f"확인: python .claude/hooks/gate_ledger_table.py --check"
    )
    return 2


def run_selftest() -> int:
    """게이트 자체의 검증. 고장 난 센서는 없는 센서보다 나쁘다 —
    통과하고 있다고 착각하게 만들기 때문이다.

    `must_pass`가 이 게이트의 핵심이다. 이 결함의 최초 진단이 틀렸던 이유가
    **이미 올바르게 이스케이프된 행을 깨진 것으로 오탐**한 것이었으므로,
    그 회귀를 여기서 못박는다.
    """
    header = "| 순번 | 작업 | 관련 RQ/ADR | 상태 | 참조 파일 | 비고 |"
    sep = "|---|---|---|---|---|---|"

    def table(*rows: str) -> str:
        return "\n".join((header, sep) + rows)

    # 차단해야 하는 것 — 실제로 원장에서 발생했던 네 가지 파손
    must_block = [
        ("열 수 부족(참조 파일 열 소실)",
         table("| 22h | **제목** | RQ-43 | ⬜ | 비고가 참조 칸으로 밀렸다 |")),
        ("열 수 초과(맨 파이프 — semver)",
         table("| 28a | **제목** | RQ-04 | ✅ | `브랜치` | `^20.19.0 || ^22.13.0` 이다 |")),
        ("열 수 초과(맨 파이프 — JS 논리 OR)",
         table("| 22f | **제목** | RQ-20 | ⬜ | `파일` | `a.jump || b.jump` 경합 |")),
        ("상태 열 앞 이스케이프 파이프(집계 오염)",
         table("| 26l | **미이스케이프 `\\|`로 표가 깨진다** | ADR-0012 | ⬜ | `파일` | 비고 |")),
    ]

    # 통과해야 하는 것 — 오탐 회귀 방지가 목적이다
    must_pass = [
        ("정상 행",
         table("| 26s | **제목** | RQ-31 | ✅ | `파일` | 비고 |")),
        ("이스케이프 파이프가 상태 열 뒤(21a-2·22u·22z5 형태)",
         table("| 22u | **제목** | RQ-90 | ⬜ | `파일` | `\\|dir\\|`=1000이면 통과 |")),
        ("이스케이프 파이프가 비고에 여러 개(28a 수정 후 형태)",
         table("| 28a | **제목** | RQ-04 | ✅ | `브랜치` | `^20.19.0 \\|\\| ^22.13.0` 과 `^20.0.0 \\|\\| ^22.0.0` |")),
        ("빈 참조 파일 열(파이프는 있다)",
         table("| 23 | **단계 행** | RQ-40 | ⬜ |  | 비고 |")),
        ("표가 여러 개",
         table("| 1 | **a** | RQ-01 | ✅ | `f` | b |") + "\n\n산문\n\n"
         + table("| 2 | **c** | RQ-02 | ⬜ | `g` | d |")),
    ]

    failed = []
    for name, text in must_block:
        violations, _ = check_text(text)
        if not violations:
            failed.append(f"차단 실패 — {name}")
    for name, text in must_pass:
        violations, _ = check_text(text)
        if violations:
            failed.append(f"오탐 — {name}: {violations}")

    # 훅 경로(코드 스팬 안 맨 파이프) 판정도 함께 못박는다.
    hook_block = [
        ("코드 스팬 안 맨 파이프", "`a || b`"),
        ("절댓값 기호(2026-07-29 실제 사고)", "거리 `|r - 0.5|` 가 반경을 넘으면"),
    ]
    hook_pass = [
        ("이스케이프된 파이프", "`\\|dir\\|`"),
        ("코드 스팬 밖 셀 경계", "| a | b |"),
        ("파이프 없음", "평범한 `코드` 인용"),
    ]
    for name, text in hook_block:
        if not bare_pipes_in_code_spans(text):
            failed.append(f"훅 차단 실패 — {name}")
    for name, text in hook_pass:
        if bare_pipes_in_code_spans(text):
            failed.append(f"훅 오탐 — {name}")

    if failed:
        _stderr("[원장 표 게이트 selftest] 실패 %d건:\n  %s"
                % (len(failed), "\n  ".join(failed)))
        return 1
    print("[원장 표 게이트 selftest] 통과 — 차단 %d건·허용 %d건 확인."
          % (len(must_block) + len(hook_block), len(must_pass) + len(hook_pass)))
    return 0


def main() -> None:
    _force_utf8()
    argv = sys.argv[1:]
    if not argv:
        sys.exit(run_hook())
    mode = argv[0]
    if mode == "--check":
        sys.exit(run_check())
    if mode == "--selftest":
        sys.exit(run_selftest())
    _stderr(f"알 수 없는 모드: {mode}\n{__doc__}")
    sys.exit(64)


if __name__ == "__main__":
    main()
