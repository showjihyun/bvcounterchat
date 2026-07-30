#!/usr/bin/env python3
r"""원장 표 무결성 게이트 — `harness/progress.md`의 GFM 표가 깨지는 것을 막는다.

원장은 이 프로젝트의 진행 기록이자 이월 항목의 유일한 보관소다(ADR-0012:
"이월을 원장으로 몰아주는 정책의 안전성은 원장 무결성에 정비례한다"). 그런데
표가 깨져도 지금까지 **아무것도 실패하지 않았다** — 2026-07-30 이전까지 열 수가
어긋난 7개 행이 CI를 통과했다.

무엇이 깨졌었나(실측):
  - `28a` — semver 범위 인용의 맨 파이프 8쌍. GFM은 초과 셀을 **버리므로**
    비고가 `engines`를 인용하는 지점에서 잘렸다(16셀·1,626자 소실).
  - `22f` — JS 논리 OR 1쌍. `jump: next.jump` 지점에서 잘렸다(168자 소실).
  - `22h`~`22l` — 참조 파일 열이 통째로 빠져 비고가 그 칸으로 밀렸다.
  - `26l` — **열 수는 정상이었다(집계 오염 경로다).** 이스케이프된 파이프가
    **제목 열**(상태 열 앞)에 있어, 열 인덱스로 세는 스크립트가 상태칸을 RQ 열로
    읽었다. ⬜ 집계가 97로 나오고 참값은 98이었다 — 그 수치가 ADR-0012 조건 2의
    재검토 임계를 가른다.

**왜 규율로는 안 되는가**: 이 결함은 파이프 문자를 타이핑하는 순간마다
재발한다. 2026-07-29 라운드에서 오케스트레이터가 절댓값 기호를 코드 스팬에
넣어 `26s` 행을 깨뜨렸다가 같은 커밋에서 고쳤다 — 같은 결함을 고치고 있던
바로 그 라운드에서다.

## 파이프를 셀 안에 넣는 정본 방법 — 백슬래시 **하나**

GitHub 실제 렌더러(`api.github.com/markdown`, `mode: gfm`)로 실측한 결과:

  | 표기            | 코드 스팬 안                          | 코드 스팬 밖                    |
  |-----------------|---------------------------------------|---------------------------------|
  | 맨 파이프       | 열 분리(파손) — 백틱까지 깨진다       | 열 분리(파손)                   |
  | 백슬래시 1개    | **정상**(렌더에 파이프만 남는다)      | **정상**                        |
  | 백슬래시 2개    | 열은 유지되나 백슬래시가 **노출**된다 | 정상(인라인 이스케이프가 먹는다) |
  | `&#124;` 엔티티 | **디코딩 안 됨** — 리터럴이 보인다    | 정상                            |

즉 **파이프 앞에 백슬래시 하나**가 정답이다(코드 스팬 안이든 밖이든). 원장
`26l`이 최초에 적은 "코드 스팬 안에서는 이중 백슬래시가 필요하다"와 `26ag`가
적은 "`&#124;`로 치환한다"는 **둘 다 거짓**이며 2026-07-30에 정정됐다.

## 이 게이트가 naive 분할을 쓰지 않는 이유

`awk -F'|'`는 이스케이프를 모른다. 수정 **전** 원장을 그 방식으로 세면 이미
올바르게 이스케이프된 4개 행(`21a-2`·`26l`·`22u`·`22z5`)을 **오탐**한다 —
실제로 그 오탐이 이 결함의 최초 진단을 틀리게 만들어 "12행이 깨졌다"는 잘못된
기록을 낳았다(참값은 7행). 그래서 이 게이트는 `(?<!\\)\|`로 나눈다.

## 한계 — 통과가 무엇을 증명하지 않는가

  - **표 구조만** 본다. 셀 내용의 정확성(수치가 최신인가, 트리거가 유효한가)은
    보지 않는다 — 그것은 사람과 리뷰의 몫이다.
  - **`harness/progress.md` 한 파일만** 본다. 같은 표 구조의 다른 하네스 문서
    (`changelog.md` 등)는 무검출이다(원장 26al로 이월).

실행 모드
---------
  (stdin에 JSON)   PreToolUse hook. exit 2 = 도구 호출 차단.
                   원장 경로일 때만 동작한다. 전문을 받는 Write는 표 구조까지,
                   조각만 받는 Edit는 **코드 스팬 안의 파이프**만 본다
                   (정상 셀 경계 파이프는 백틱 밖이라 오탐이 없다).
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
# 백틱 코드 스팬. **DOTALL을 쓰지 않는다** — 미닫힌 백틱 하나가 행 경계를 넘어
# 짝지어져 셀 경계 파이프를 스팬 안으로 삼키면, GFM은 정상 렌더하는데 훅이
# "코드 스팬 안에 파이프가 있다"는 없는 원인으로 편집을 막는다(리뷰 minor 5).
CODE_SPAN = re.compile(r"(?<!`)(`+)(?!`)([^\n]+?)(?<!`)\1(?!`)")
# 구분선 셀: `---` `:---` `---:` `:---:`
SEPARATOR_CELL = re.compile(r"^:?-+:?$")
# 원장 상태 열이 가질 수 있는 선행 기호. 뒤에 괄호 부기가 붙는 것은 허용한다
# (`✅ (26s로 흡수 종결)` 형태가 실존한다 — 리뷰 minor 8).
STATUS_TOKENS = ("⬜", "✅", "🔄", "⛔", "🟡")
# 원장 표(6열)에서 상태 열의 인덱스. CELL_SPLIT 결과는
# ['', 순번, 작업, 관련RQ, 상태, 참조파일, 비고, ''] 로 8필드다.
STATUS_INDEX = 4
# 이 인덱스 규약이 성립하는 표를 식별하는 헤더 첫 칸.
LEDGER_HEADER = "순번"
HTML_PIPE_ENTITY = "&#124;"


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
    inner = cells[1:-1] if len(cells) > 2 else []
    return bool(inner) and all(SEPARATOR_CELL.match(c) for c in inner)


def code_span_pipe_hits(text: str) -> tuple[list[str], list[str]]:
    """(맨 파이프를 담은 코드 스팬, 백틱이 홀수인 행) 을 낸다.

    정상적인 셀 경계 파이프는 백틱 **밖**에 있으므로 첫 목록에 걸리지 않는다.
    이 판정이 좁은 것은 의도다 — 훅은 편집을 막으므로 오탐 비용이 크다.

    **왜 셀을 먼저 나누지 않는가**: GFM은 셀을 먼저 나눈 뒤 인라인을 처리하므로
    셀 분할이 GFM의 순서다. 그러나 이 게이트가 잡으려는 결함은 "**작성자가 코드
    스팬으로 의도한 것 안에 맨 파이프가 있다**"는 것이고, 셀을 먼저 나누면 그
    의도가 파괴돼 결함이 사라진다. 그래서 raw 행에서 짝짓는다.

    **그 대가가 미닫힌 백틱이다**(리뷰 minor 5). 백틱이 홀수인 행에서는 짝짓기가
    신뢰할 수 없어 셀 경계 파이프를 스팬 안으로 삼킨다 — GFM은 정상 렌더하므로
    오탐이다. 그런 행은 **차단하지 않고 별도로 알린다**. 그것이 실제 원인이며,
    "코드 스팬 안에 파이프가 있다"는 없는 원인을 가리키는 것보다 낫다.
    """
    hits: list[str] = []
    odd_backtick: list[str] = []
    for line in text.split("\n"):
        if line.count("`") % 2 == 1:
            odd_backtick.append(line.strip()[:60])
            continue  # 짝짓기가 신뢰할 수 없다 — 오탐을 내지 않는다
        for match in CODE_SPAN.finditer(line):
            if CELL_SPLIT.search(match.group(2)):
                hits.append(match.group(0))
    return hits, odd_backtick


def check_text(text: str) -> tuple[list[str], list[str]]:
    """원장 본문의 표 구조를 검사해 (위반, 경고) 목록을 낸다.

    표 판정은 **일반적**이다 — 비파이프 행 뒤 첫 파이프 행을 헤더로 보고, 기대
    열 수를 그 헤더에서 읽는다. 헤더 이름을 센티넬로 쓰면 헤더를 굵게 바꾸는
    것만으로 표 전체가 검사에서 빠지면서 "위반 0건"이 출력된다(리뷰 major 2).
    상태 열 검사만 원장 6열 규약(`순번` 헤더)에 한정한다.
    """
    violations: list[str] = []
    warnings: list[str] = []
    expected: int | None = None
    awaiting_separator = False
    is_ledger_shape = False
    tables = 0
    ledger_tables = 0

    for lineno, raw in enumerate(text.split("\n"), 1):
        if not raw.startswith("|"):
            # 표가 끝났다. 다음 표는 자기 헤더에서 열 수를 다시 읽어야 한다 —
            # 초기화하지 않으면 열 구성이 다른 새 표가 직전 표의 열 수로
            # 판정돼 틀린 진단으로 CI를 막는다(리뷰 major 2).
            if awaiting_separator:
                violations.append(
                    f"  {lineno - 1}행: 헤더 다음 행이 구분선이 아니다 — "
                    f"GFM은 이 표를 **아예 렌더하지 않는다**(단락이 된다)"
                )
            expected = None
            awaiting_separator = False
            is_ledger_shape = False
            if "|" in raw:
                warnings.append(
                    f"  {lineno}행: 표 밖에 파이프가 있다 — 표 판정 전제가 흔들릴 수 있다"
                )
            continue

        cells = split_cells(raw)

        if expected is None:
            # 표의 첫 파이프 행 = 헤더.
            tables += 1
            expected = len(cells)
            awaiting_separator = True
            is_ledger_shape = len(cells) > 1 and cells[1] == LEDGER_HEADER
            if is_ledger_shape:
                ledger_tables += 1
            continue

        if awaiting_separator:
            awaiting_separator = False
            if not is_separator_row(cells):
                violations.append(
                    f"  {lineno}행: 헤더 다음 행이 구분선이 아니다 — "
                    f"GFM은 이 표를 **아예 렌더하지 않는다**(단락이 된다)"
                )
                expected = None
                is_ledger_shape = False
            elif len(cells) != expected:
                violations.append(
                    f"  {lineno}행: 구분선 열 수가 헤더와 다르다 — "
                    f"{len(cells)}개(헤더 {expected}개). "
                    f"GFM은 이 표를 **아예 렌더하지 않는다**"
                )
            continue

        row_id = cells[1] if len(cells) > 1 else "?"

        if len(cells) != expected:
            kind = "부족" if len(cells) < expected else "초과"
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

        if not is_ledger_shape:
            continue

        # 열 수가 맞아도, 상태 열 **앞**에 이스케이프된 파이프가 있으면
        # 열 인덱스로 세는 다른 스크립트가 상태칸을 한 칸 밀려 읽는다.
        # `26l`이 그래서 ⬜ 집계를 97로 만들었다(참값 98).
        head = "|".join(cells[1:STATUS_INDEX])
        if "\\|" in head:
            violations.append(
                f"  {lineno}행 [{row_id}] 상태 열 앞에 이스케이프된 파이프가 있다 — "
                f"열 인덱스로 세는 스크립트가 상태칸을 잘못 읽는다"
                f"(⬜/✅ 집계가 조용히 틀어진다). 그 파이프를 산문으로 바꿔라"
            )

        # 위치가 맞아도 어휘가 어긋나면 정확 일치로 세는 사람이 놓친다.
        status = cells[STATUS_INDEX] if len(cells) > STATUS_INDEX else ""
        if status and not status.startswith(STATUS_TOKENS):
            violations.append(
                f"  {lineno}행 [{row_id}] 상태 열이 알 수 없는 값이다: {status!r} — "
                f"{'·'.join(STATUS_TOKENS)} 중 하나로 시작해야 한다"
                f"(뒤에 괄호 부기는 허용)"
            )

    if awaiting_separator:
        violations.append(
            "  파일 끝: 헤더 다음 행이 구분선이 아니다 — GFM은 이 표를 렌더하지 않는다"
        )
    if tables == 0:
        violations.append(
            "  표를 하나도 찾지 못했다 — 원장에는 표가 있어야 한다. "
            "검사가 조용히 아무것도 하지 않는 상태이므로 위반으로 보고한다"
        )
    elif ledger_tables == 0:
        # 표 구조 검사는 헤더 이름에 무관하지만 **상태 열 검사는** `순번` 규약에
        # 의존한다. 헤더를 바꾸면 그 검사가 조용히 꺼지므로 위반으로 보고한다.
        violations.append(
            f"  `{LEDGER_HEADER}` 헤더 표를 찾지 못했다 — 상태 열 검사가 조용히 "
            f"꺼진 상태다(집계 오염을 못 잡는다). 헤더 첫 칸을 확인하라"
        )

    return violations, warnings


def run_check(ledger: Path = LEDGER) -> int:
    if not ledger.exists():
        _stderr(f"[원장 표 게이트] 원장을 찾을 수 없다: {ledger}")
        return 1
    text = ledger.read_text(encoding="utf-8")
    violations, warnings = check_text(text)
    span_hits, odd_backtick = code_span_pipe_hits(text)
    for line in odd_backtick:
        warnings.append(f"  백틱이 홀수인 행 — 코드 스팬 짝짓기를 신뢰할 수 없다: {line}")
    for warn in warnings:
        print(f"[원장 표 게이트] 경고:\n{warn}")
    if span_hits:
        sample = ", ".join(span_hits[:3]) + ("..." if len(span_hits) > 3 else "")
        violations.append(f"  코드 스팬 안에 맨 파이프가 있다: {sample}")
    if violations:
        _stderr(
            "[원장 표 게이트] 표 무결성 위반 %d건:\n%s\n"
            "파이프를 셀 안에 넣으려면 **백슬래시 하나**를 앞에 붙인다 — "
            "이중 백슬래시는 코드 스팬 안에서 백슬래시가 노출되고, "
            "`%s`는 코드 스팬 안에서 디코딩되지 않는다(2026-07-30 실측)."
            % (len(violations), "\n".join(violations), HTML_PIPE_ENTITY)
        )
        return 1
    # 몇 개를 봤는지 함께 찍는다 — 침묵을 커버리지로 오해하지 않도록.
    tables = sum(1 for line in text.split("\n") if line.startswith("| 순번 "))
    print(f"[원장 표 게이트] 위반 0건 (원장 표 {tables}개 검사).")
    return 0


def run_hook() -> int:
    """PreToolUse hook. 원장을 쓰는 도구 호출을 검사한다."""
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8", errors="replace"))
    except (json.JSONDecodeError, OSError, ValueError):
        return 0  # 파싱 실패는 이 게이트의 관할이 아니다
    if not isinstance(payload, dict):
        return 0  # 리스트·스칼라 payload에 AttributeError로 죽지 않는다(리뷰 minor 10)

    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return 0
    file_path = (tool_input.get("file_path") or tool_input.get("path") or "")
    if not _is_ledger_path(file_path):
        return 0

    problems: list[str] = []

    # Write는 전문을 주므로 표 구조까지 볼 수 있다(리뷰 minor 6 — 열 수 부족
    # 형태가 편집 시점에 통과하던 구멍). Edit 조각에는 적용하지 않는다.
    content = tool_input.get("content")
    if isinstance(content, str):
        violations, _ = check_text(content)
        problems.extend(violations)

    fragments = [content] if isinstance(content, str) else []
    if isinstance(tool_input.get("new_string"), str):
        fragments.append(tool_input["new_string"])
    for edit in tool_input.get("edits") or []:
        if isinstance(edit, dict) and isinstance(edit.get("new_string"), str):
            fragments.append(edit["new_string"])

    hits: list[str] = []
    for text in fragments:
        found, _odd = code_span_pipe_hits(text)
        hits.extend(found)
    if hits:
        sample = ", ".join(hits[:3]) + ("..." if len(hits) > 3 else "")
        problems.append(f"  코드 스팬 안의 맨 파이프: {sample}")

    if not problems:
        return 0

    _stderr(
        "[원장 표 게이트] 원장 표를 깨뜨리는 편집이다:\n%s\n"
        "GFM은 셀 경계 파이프로 읽어 그 행의 비고를 **잘라 버린다** "
        "(원장 28a·22f가 실제로 그렇게 깨져 있었다).\n"
        "해결: 파이프 앞에 **백슬래시 하나**를 붙여라. 이중 백슬래시는 코드 스팬 "
        "안에서 백슬래시가 노출되고, `%s`는 코드 스팬 안에서 디코딩되지 않는다.\n"
        "확인: python .claude/hooks/gate_ledger_table.py --check"
        % ("\n".join(problems), HTML_PIPE_ENTITY)
    )
    return 2


def _is_ledger_path(path_str: str) -> bool:
    """이 경로가 원장인가. 기존 두 훅과 같은 형태로 정규화한다.

    접미사 일치(`endswith`)를 쓰면 프로젝트 밖의 동명 파일이나
    `xharness/progress.md`도 걸린다(리뷰 minor 7).
    """
    if not path_str:
        return False
    p = Path(path_str.replace("\\", "/"))
    try:
        rel = p.resolve().relative_to(ROOT) if p.is_absolute() else p
    except (ValueError, OSError):
        return False  # 프로젝트 밖 경로는 이 게이트의 관할이 아니다
    return rel.as_posix() == "harness/progress.md"


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

    must_block = [
        ("열 수 부족(참조 파일 열 소실)",
         table("| 22h | **제목** | RQ-43 | ⬜ | 비고가 참조 칸으로 밀렸다 |")),
        ("열 수 초과(맨 파이프 — semver)",
         table("| 28a | **제목** | RQ-04 | ✅ | `브랜치` | `^20.19.0 || ^22.13.0` 이다 |")),
        ("열 수 초과(맨 파이프 — JS 논리 OR)",
         table("| 22f | **제목** | RQ-20 | ⬜ | `파일` | `a.jump || b.jump` 경합 |")),
        ("상태 열 앞 이스케이프 파이프(집계 오염)",
         table("| 26l | **미이스케이프 `\\|`로 표가 깨진다** | ADR-0012 | ⬜ | `파일` | 비고 |")),
        ("구분선 열 수 불일치(표가 렌더되지 않는다)",
         header + "\n|---|---|---|\n| 1 | **a** | RQ-01 | ✅ | `f` | b |"),
        ("구분선 행 부재(표가 렌더되지 않는다)",
         header + "\n| 1 | **a** | RQ-01 | ✅ | `f` | b |"),
        ("헤더 이름이 바뀌어도 파손 데이터 행을 잡는다",
         "| **순번** | 작업 | 관련 | 상태 | 참조 | 비고 |\n" + sep
         + "\n| 22h | **제목** | RQ-43 | ⬜ | 비고가 밀렸다 |"),
        ("상태 열 어휘가 알 수 없는 값",
         table("| 9z | **제목** | RQ-01 | 진행중 | `파일` | 비고 |")),
        ("표가 하나도 없다(검사가 무성 통과하지 않는다)", "표가 없는 산문뿐이다\n"),
    ]

    must_pass = [
        ("정상 행",
         table("| 26s | **제목** | RQ-31 | ✅ | `파일` | 비고 |")),
        ("이스케이프 파이프가 상태 열 뒤(21a-2·22u·22z5 형태)",
         table("| 22u | **제목** | RQ-90 | ⬜ | `파일` | `\\|dir\\|`=1000이면 통과 |")),
        ("이스케이프 파이프가 비고에 여러 개(28a 수정 후 형태)",
         table("| 28a | **제목** | RQ-04 | ✅ | `브랜치` | `^20.19.0 \\|\\| ^22.13.0` 과 `^20.0.0 \\|\\| ^22.0.0` |")),
        ("빈 참조 파일 열(파이프는 있다)",
         table("| 23 | **단계 행** | RQ-40 | ⬜ |  | 비고 |")),
        ("상태 열에 괄호 부기(`✅ (…)` 실존 형태)",
         table("| 25j | **제목** | RQ-31 | ✅ (26s로 흡수 종결) | `파일` | 비고 |")),
        ("표가 여러 개(같은 열 수)",
         table("| 1 | **a** | RQ-01 | ✅ | `f` | b |") + "\n\n산문\n\n"
         + table("| 2 | **c** | RQ-02 | ⬜ | `g` | d |")),
        ("열 구성이 다른 두 번째 표(changelog 형태 — 오탐 금지)",
         table("| 1 | **a** | RQ-01 | ✅ | `f` | b |") + "\n\n산문\n\n"
         + "| 날짜 | 변경 내용 | 대상 | 사유 |\n|---|---|---|---|\n"
         + "| 2026-07-30 | **x** | `f` | y |"),
        ("정렬 표기 구분선",
         header + "\n|:---|:---:|---:|---|---|---|\n| 1 | **a** | RQ-01 | ✅ | `f` | b |"),
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

    hook_block = [
        ("코드 스팬 안 맨 파이프", "`a || b`"),
        ("절댓값 기호(2026-07-29 실제 사고)", "거리 `|r - 0.5|` 가 반경을 넘으면"),
    ]
    hook_pass = [
        ("이스케이프된 파이프", "`\\|dir\\|`"),
        ("코드 스팬 밖 셀 경계", "| a | b |"),
        ("파이프 없음", "평범한 `코드` 인용"),
        ("미닫힌 백틱은 차단하지 않는다(오탐 금지 — GFM은 정상 렌더한다)",
         "| 1 | `열린 | RQ | ⬜ | `f` | x |"),
        ("행을 넘어 짝짓지 않는다",
         "첫 행의 `열린 백틱\n둘째 행의 파이프 | 는 무관하다`"),
        ("`&#124;` 엔티티를 서술하는 문장(정당한 문서화 — 오탐 금지)",
         "낡은 처방 `&#124;`는 코드 스팬 안에서 디코딩되지 않는다"),
    ]
    for name, text in hook_block:
        found, _ = code_span_pipe_hits(text)
        if not found:
            failed.append(f"훅 차단 실패 — {name}")
    for name, text in hook_pass:
        found, _ = code_span_pipe_hits(text)
        if found:
            failed.append(f"훅 오탐 — {name}: {found}")

    # 미닫힌 백틱은 차단이 아니라 별도 진단으로 나와야 한다.
    _, odd = code_span_pipe_hits("| 1 | `열린 | RQ | ⬜ | `f` | x |")
    if not odd:
        failed.append("미닫힌 백틱을 별도 진단으로 알리지 않는다")

    # 경로 판정 — 프로젝트 밖 동명 파일을 관할로 착각하지 않는다.
    path_cases = [
        (str(ROOT / "harness" / "progress.md"), True),
        ("harness/progress.md", True),
        (r"harness\progress.md", True),
        ("xharness/progress.md", False),
        ("harness/changelog.md", False),
        ("", False),
    ]
    for path, expected in path_cases:
        if _is_ledger_path(path) != expected:
            failed.append(f"경로 판정 — {path!r}: expected {expected}")

    if failed:
        _stderr("[원장 표 게이트 selftest] 실패 %d건:\n  %s"
                % (len(failed), "\n  ".join(failed)))
        return 1
    print("[원장 표 게이트 selftest] 통과 — 차단 %d건·허용 %d건·경로 %d건 확인."
          % (len(must_block) + len(hook_block),
             len(must_pass) + len(hook_pass), len(path_cases)))
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
