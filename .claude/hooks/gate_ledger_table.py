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
  - **코드 스팬 안의 `&#124;`는 검출하지 않는다.** 오류 메시지가 그 표기를
    권하지 않는다고 안내하면서도 잡지는 않는다 — 검출을 넣었더니 **원장이 그
    엔티티를 정당하게 서술하는 문장**(거짓 처방을 설명하는 대목)에서 오탐이
    났다. 되돌린 사유는 원장 26ag에 있다.
  - **원장 파일 안의 6열 비원장 부록 표를 오탐한다**(원장 26al ③). 개명된 원장
    표를 잡으려고 필드 수를 세는 트레이드오프의 이면이다 — 원장에 우연히 6열인
    부록 표가 생기면 "`순번` 헤더가 아니다"로 막힌다. 현재 그런 표는 0개다.
    막히면 그 표의 열 수를 바꾸거나 `순번` 규약을 따르면 된다.
  - **블록쿼트(`>`) 안의 표는 보지 않는다.** `specs/requirements.md`의 개정 이력
    표가 그 형태다 — 검사 대상 목록에는 있으나 이 파일에서 검출되는 표는 0개다.

실행 모드
---------
  (stdin에 JSON)   PreToolUse hook. exit 2 = 도구 호출 차단.
                   검사 대상 경로일 때만 동작한다. 전문을 받는 Write는 표 구조까지,
                   조각만 받는 Edit는 **코드 스팬 안의 파이프**만 본다
                   (정상 셀 경계 파이프는 백틱 밖이라 오탐이 없다).
  --check          검사 대상 전체 검사. 위반이 있으면 exit 1.
  --selftest       내장 검증. 게이트 자체가 고장 났는지 확인한다.

## 무엇을 검사하는가 — 한 파일에서 `harness/**/*.md` 전체로 (원장 26al)

이 게이트는 처음에 `harness/progress.md` 하나만 봤다. 그런데 **같은 결함이 다른
하네스 문서에도 있었다** — `changelog.md`에 원장 `28a`를 깨뜨린 것과 동일한 semver
인용·동일한 맨 파이프가 있어 초과 2셀이 버려지고 있었다(PR #39가 그 1건은
고쳤지만 게이트는 여전히 그 파일을 보지 않았다).

커버리지를 `harness/**/*.md`로 넓히자 **즉시 실파손 1건이 더 나왔다**:
`adr/0004-physics-collision.md`의 RQ-92 **확정값 표**에서 "공중 가속" 행이 두 줄로
쪼개져 뒷문장이 `항목` 칸으로 렌더되고 있었다. 하필 RQ-21·22 이동 라운드가 읽을
표다. **손으로 관리하는 파일 목록이 아니라 글로브**를 쓰는 이유가 이것이다 —
목록이 드리프트하는 것이 26al이 지적한 병 그 자체다.

원장 규약(상태 열 검사·최소 표 수)은 `harness/progress.md`에만 적용한다
(`ledger_mode`). 다른 문서는 표 구조만 본다 — 열 구성이 파일마다 다르고, 표가
아예 없는 파일(`evals/README.md`)도 목록에 들어오기 때문이다.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
LEDGER = ROOT / "harness" / "progress.md"
# 검사 대상. 손으로 적은 목록은 드리프트한다 — 그것이 26al이 지적한 병이라
# 글로브를 쓴다. 원장 규약은 `LEDGER`에만 적용한다(`ledger_mode`).
GATED_GLOB = "harness/**/*.md"
# 원장이 가져야 하는 최소 원장 규약 표 수(현재 3: 하네스 구축·Deep Interview·로드맵).
# **개명과 열 수 변경을 함께** 하면 `순번` 검사도 `LEDGER_FIELDS` 검사도 빠져나가
# 상태 열 검사 3종이 무성으로 꺼진다(원장 26al ④). 그 경로를 이 최소치가 막는다.
MIN_LEDGER_TABLES = 3

# 이스케이프되지 않은 파이프만 셀 구분자로 인정한다.
CELL_SPLIT = re.compile(r"(?<!\\)\|")
# 코드 펜스. 펜스 안의 파이프를 표 행으로 오판하지 않기 위해 상태를 추적한다
# (원장 26al ②). 여는 펜스와 같은 문자·같은 길이 이상이어야 닫힌다.
FENCE = re.compile(r"^(`{3,}|~{3,})")
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
# 이 인덱스 규약이 성립하는 표를 식별하는 헤더 첫 칸과 상태 칸.
LEDGER_HEADER = "순번"
STATUS_HEADER = "상태"
# 원장 규약 표의 필드 수(6열 + 앞뒤 빈 필드).
LEDGER_FIELDS = 8
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


def check_text(
    text: str,
    ledger_mode: bool = True,
    stats: dict | None = None,
    min_ledger_tables: int = 0,
) -> tuple[list[str], list[str]]:
    """원장 본문의 표 구조를 검사해 (위반, 경고) 목록을 낸다.

    표 판정은 **일반적**이다 — 비파이프 행 뒤 첫 파이프 행을 헤더로 보고, 기대
    열 수를 그 헤더에서 읽는다. 헤더 이름을 센티넬로 쓰면 헤더를 굵게 바꾸는
    것만으로 표 전체가 검사에서 빠지면서 "위반 0건"이 출력된다(리뷰 major 2).

    `ledger_mode`가 참이면 **표마다** 원장 규약을 요구한다 — 상태 열 검사가
    `STATUS_INDEX` 위치 규약에 의존하므로 두 방향을 함께 본다:

      - `순번` 헤더 표인데 `STATUS_INDEX` 칸이 `상태`가 아니면 위반. 열을 하나
        끼워 넣는 것만으로 검사 3종이 **조용히 다른 열로 옮겨간다**(2회차 minor 2).
      - `LEDGER_FIELDS`(원장 6열) 표인데 `순번` 헤더가 아니면 위반. 파일 단위로
        "`순번` 표가 하나라도 있는가"만 보면 **대형 표 하나만 개명해도 나머지
        표가 카운터를 채워 rc=0이 된다**(1회차 major 1, 140행 표로 실측).

    열 구성이 다른 부록 표(4열 changelog 형태 등)는 이 요구에서 제외한다 — GFM은
    정상 렌더하므로 요구하면 오탐이다(2회차 minor 1).

    거짓이면 그 요구를 끄고 표 구조만 본다(원장이 아닌 파일에 쓸 때 — 원장 26al).
    `stats`를 주면 검사한 표 수를 담아 돌려준다.

    ## 표 행을 무엇으로 보는가 (원장 26al ①②⑤)

    GFM은 `| a | b |`뿐 아니라 **선행 파이프 없는** `a | b`도 표 행으로 받고, 표는
    빈 줄에서 끝난다. `startswith("|")`만 보면 두 경로를 놓친다:

      - **헤더에 선행 파이프가 없는 표** — 다음 줄이 구분선이면 표다. 앞을 내다봐서
        잡는다.
      - **표 안의 선행 파이프 없는 행** — GFM이 그 줄을 행으로 흡수한다. 실측:
        `adr/0004`의 "공중 가속" 행이 두 줄로 쪼개져 뒷문장이 `항목` 칸으로
        렌더되고 있었다.

    다만 **파이프가 하나도 없는 줄은 표를 끝낸 것으로 본다.** GFM은 그것도 1셀 행으로
    흡수하지만, 그렇게 보면 표 바로 뒤 산문 한 줄마다 "열 수 부족"이 쏟아진다 —
    오탐이 CI를 막는 방향이라 미탐보다 나쁘다. 좁은 쪽을 택하고 selftest로 못박는다.

    코드 펜스(```) 안은 표가 아니다 — 펜스를 추적해 건너뛴다(②). 구분선이 깨져
    표가 렌더되지 않을 때는 **그 표를 통째로 건너뛴다**(⑤) — 이어서 검사하면
    데이터 행을 헤더로 오진하며 진단 수백 건이 쏟아져 첫 메시지가 묻힌다.
    """
    violations: list[str] = []
    warnings: list[str] = []
    expected: int | None = None
    awaiting_separator = False
    is_ledger_shape = False
    tables = 0
    ledger_tables = 0
    fence: str | None = None
    skipping = False  # 구분선 파손 뒤 그 표를 건너뛰는 중

    lines = text.split("\n")

    def is_separator_line(nxt: str) -> bool:
        """구분선인가. **선행 파이프 없는 형태(`---|---`)도 인정한다** — 이 판정은
        헤더 앞을 내다보는 데만 쓰이므로 두 형태를 모두 받아야 한다."""
        s = nxt.lstrip(" \t")
        if not s or CELL_SPLIT.search(s) is None:
            return False
        inner = [c for c in split_cells(s) if c]
        return bool(inner) and all(SEPARATOR_CELL.match(c) for c in inner)

    for lineno, line in enumerate(lines, 1):
        # 코드 펜스 안은 마크다운이 아니다 — 파이프가 있어도 표 행이 아니다.
        m_fence = FENCE.match(line.lstrip(" \t"))
        if m_fence:
            token = m_fence.group(1)
            if fence is None:
                fence = token[0]
                expected = None
                awaiting_separator = False
                is_ledger_shape = False
                skipping = False
            elif token[0] == fence:
                fence = None
            continue
        if fence is not None:
            continue

        if skipping:
            # 파손된 표를 건너뛰는 중. 빈 줄이나 파이프 없는 줄에서 해제한다.
            if not line.strip() or CELL_SPLIT.search(line) is None:
                skipping = False
            else:
                continue

        # GFM은 표 행에 최대 3칸 들여쓰기를 허용한다. 들여쓴 행을 표 밖으로 보면
        # 표 상태가 초기화돼 이후 행에 **틀린 진단**이 나온다(1회차 minor 5).
        stripped = line.lstrip(" \t")
        indent = len(line) - len(stripped)
        over_indented = stripped.startswith("|") and (
            "\t" in line[:indent] or indent >= 4
        )
        if over_indented:
            # GFM은 4칸 이상(또는 탭) 들여쓴 행을 코드 블록으로 읽어 **실제로 행을
            # 잃는다** — 차단은 정당하다. 그러나 표 상태를 끊으면 이후 행에 위반이
            # 쏟아지고 첫 메시지가 원인을 잘못 지목한다(2회차 minor 3, 실측 94건).
            # 전용 메시지 하나만 내고 표 검사는 그대로 이어 간다.
            violations.append(
                f"  {lineno}행: 표 행이 4칸 이상(또는 탭) 들여쓰여 있다 — "
                f"GFM이 코드 블록으로 읽어 이 행과 이후 표를 버린다"
            )
            continue
        raw = stripped if indent <= 3 else line
        has_pipe = CELL_SPLIT.search(raw) is not None
        if not raw.startswith("|"):
            # 선행 파이프가 없어도 GFM은 표 행으로 받는다(원장 26al ①). 두 경로를
            # 각각 **전용 진단**으로 처리한다 — 열 수 비교로 흘려보내면 필드 수
            # 규약(선행·후행 빈 필드)이 달라 틀린 수치를 찍는다.
            if expected is not None and raw.strip() and has_pipe:
                # 표 안의 선행 파이프 없는 행. GFM이 **별개 행으로 흡수**하므로
                # 이 줄이 첫 칸으로 밀린다. 실측: `adr/0004`의 "공중 가속" 행이
                # 두 줄로 쪼개져 뒷문장이 `항목` 칸으로 렌더되고 있었다.
                violations.append(
                    f"  {lineno}행: 표 안에 선행 파이프 없는 행이 있다 — GFM이 "
                    f"별개 행으로 흡수해 이 줄이 **첫 칸으로 밀린다**. 앞 행의 "
                    f"이어짐으로 의도했다면 한 줄로 합쳐라: {raw.strip()[:50]!r}"
                )
                continue
            if (
                expected is None
                and raw.strip()
                and has_pipe
                and lineno < len(lines)
                and is_separator_line(lines[lineno])
            ):
                # 선행 파이프 없는 헤더. GFM은 정상 렌더하므로 **막지 않는다** —
                # 다만 이 저장소의 표는 전부 선행 파이프 규약이라 열 수 비교가
                # 그 형태를 전제한다. 그 표는 통째로 건너뛴다(틀린 진단 방지).
                warnings.append(
                    f"  {lineno}행: 표 헤더에 선행 파이프가 없다 — 렌더는 정상이나 "
                    f"이 게이트의 열 수 검사는 이 표를 건너뛴다"
                )
                skipping = True
                continue
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
            # **원장에서만** 알린다. 원장은 거의 전부가 표라 표 밖 파이프가
            # 의심스럽지만, 일반 하네스 문서에서는 산문·블록쿼트·코드 스팬 사이의
            # 파이프가 정상이다 — 커버리지를 넓히자 이 경고만 12건이 나왔다
            # (`requirements.md`의 블록쿼트 개정 이력 표 9건 등). 소음은 게이트를
            # 꺼지게 만드는 가장 흔한 경로다.
            if ledger_mode and "|" in raw:
                warnings.append(
                    f"  {lineno}행: 표 밖에 파이프가 있다 — 표 판정 전제가 흔들릴 수 있다"
                )
            continue

        cells = split_cells(raw)

        # 코드 스팬 안의 맨 파이프는 **표 행에서만** 결함이다. 산문·블록쿼트의
        # `a || b`는 GFM이 정상 렌더한다 — 파일 전체를 훑던 이전 방식은 커버리지를
        # `harness/**`로 넓히자마자 오탐을 냈다(실측: `infra/worker-crash-rca.md:12`의
        # 블록쿼트 semver 인용). 표 문맥으로 한정한다.
        span_hits, odd = code_span_pipe_hits(raw)
        if span_hits:
            violations.append(
                f"  {lineno}행: 코드 스팬 안에 맨 파이프가 있다 — GFM이 셀 경계로 "
                f"읽어 이 행이 잘린다: {', '.join(span_hits[:3])}"
            )
        for bad in odd:
            warnings.append(
                f"  {lineno}행: 백틱이 홀수다 — 코드 스팬 짝짓기를 신뢰할 수 없다: {bad}"
            )

        if expected is None:
            # 표의 첫 파이프 행 = 헤더.
            tables += 1
            expected = len(cells)
            awaiting_separator = True
            first = cells[1] if len(cells) > 1 else ""
            status_head = cells[STATUS_INDEX] if len(cells) > STATUS_INDEX else ""
            # 상태 열 검사는 위치 규약(`STATUS_INDEX`)에 의존한다. 헤더에서
            # 그 자리가 `상태`인지 대조하지 않으면, 열을 하나 끼워 넣는 것만으로
            # 검사 3종이 조용히 **다른 열로 옮겨간다**(델타 재평가 2회차 minor 2 —
            # 1회차 major 1과 같은 결함 계열의 인접 파라미터다).
            is_ledger_shape = first == LEDGER_HEADER and status_head == STATUS_HEADER
            if is_ledger_shape:
                ledger_tables += 1
            if ledger_mode and first == LEDGER_HEADER and not is_ledger_shape:
                violations.append(
                    f"  {lineno}행: `{LEDGER_HEADER}` 표인데 {STATUS_INDEX}번째 칸이 "
                    f"`{STATUS_HEADER}`가 아니다({status_head!r}) — 상태 열 검사 3종이 "
                    f"조용히 다른 열로 옮겨간다"
                )
            elif ledger_mode and first != LEDGER_HEADER and len(cells) == LEDGER_FIELDS:
                # 원장 규약(6열=8필드) 표는 `순번` 헤더여야 한다. 표마다 요구한다 —
                # 파일 단위로 세면 대형 표 하나만 개명해도 나머지 표가 카운터를
                # 채워 무성 통과한다(1회차 major 1). 열 구성이 다른 부록 표는
                # 이 요구에서 제외한다(2회차 minor 1 — GFM은 정상 렌더한다).
                violations.append(
                    f"  {lineno}행: 원장 규약 표({LEDGER_FIELDS}필드)인데 헤더 첫 칸이 "
                    f"`{LEDGER_HEADER}`가 아니다({first!r}) — 이 표에서 상태 열 검사"
                    f"(집계 오염 탐지)가 조용히 꺼진다"
                )
            continue

        if awaiting_separator:
            awaiting_separator = False
            # 구분선이 깨지면 GFM은 이 표를 렌더하지 않는다. 이어서 검사하면
            # 데이터 행을 헤더로 오진하며 진단이 쏟아져 **첫 메시지가 묻힌다**
            # (원장 26al ⑤ — 실측 138건). 원인을 한 번만 말하고 표를 건너뛴다.
            if not is_separator_row(cells):
                violations.append(
                    f"  {lineno}행: 헤더 다음 행이 구분선이 아니다 — "
                    f"GFM은 이 표를 **아예 렌더하지 않는다**(단락이 된다). "
                    f"이 표의 나머지 행은 건너뛴다"
                )
                expected = None
                is_ledger_shape = False
                skipping = True
            elif len(cells) != expected:
                violations.append(
                    f"  {lineno}행: 구분선 열 수가 헤더와 다르다 — "
                    f"{len(cells)}개(헤더 {expected}개). "
                    f"GFM은 이 표를 **아예 렌더하지 않는다**. "
                    f"이 표의 나머지 행은 건너뛴다"
                )
                expected = None
                is_ledger_shape = False
                skipping = True
            continue

        row_id = cells[1] if len(cells) > 1 else "?"

        if len(cells) != expected:
            kind = "부족" if len(cells) < expected else "초과"
            if kind == "초과":
                fix = "셀 안의 파이프 앞에 백슬래시 하나를 붙여라"
            elif ledger_mode:
                fix = "참조 파일 열이 빠졌는지 확인하라(빈 칸이라도 파이프는 있어야 한다)"
            else:
                # 원장 밖 문서는 열 구성이 파일마다 다르다 — 원장 전용 조언을
                # 그대로 내면 틀린 곳을 가리킨다(`adr/0004`에 "참조 파일 열"은 없다).
                fix = "빈 칸이라도 파이프는 있어야 한다. 셀이 두 줄로 쪼개졌는지 확인하라"
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
        # **빈 칸도 위반이다** — GFM은 정상 렌더하므로 눈에 안 보이는데 집계에서만
        # 조용히 빠진다. `26l`과 같은 실패 모드다(델타 재평가 minor 3).
        status = cells[STATUS_INDEX] if len(cells) > STATUS_INDEX else ""
        if not status:
            violations.append(
                f"  {lineno}행 [{row_id}] 상태 열이 비어 있다 — 렌더는 정상이지만 "
                f"⬜/✅ 집계에서 조용히 빠진다"
            )
        elif not status.startswith(STATUS_TOKENS):
            violations.append(
                f"  {lineno}행 [{row_id}] 상태 열이 알 수 없는 값이다: {status!r} — "
                f"{'·'.join(STATUS_TOKENS)} 중 하나로 시작해야 한다"
                f"(뒤에 괄호 부기는 허용)"
            )

    if awaiting_separator:
        violations.append(
            "  파일 끝: 헤더 다음 행이 구분선이 아니다 — GFM은 이 표를 렌더하지 않는다"
        )
    if stats is not None:
        stats["tables"] = tables
        stats["ledger_tables"] = ledger_tables

    if ledger_mode and min_ledger_tables and ledger_tables < min_ledger_tables:
        # **개명과 열 수 변경을 함께** 하면 `순번` 검사도 `LEDGER_FIELDS` 검사도
        # 빠져나가 상태 열 검사 3종이 조용히 꺼진다(원장 26al ④). 사고성 편집으로는
        # 도달하지 않지만(138행 전부를 고쳐야 한다) 그 경로가 열려 있는 것 자체가
        # 문제다 — 최소 개수로 막는다.
        violations.append(
            f"  원장 규약 표가 {ledger_tables}개뿐이다(최소 {min_ledger_tables}개). "
            f"헤더 개명·열 수 변경으로 상태 열 검사가 조용히 꺼지지 않았는지 확인하라 "
            f"— 표를 정당하게 줄였다면 `MIN_LEDGER_TABLES`를 함께 낮춰라"
        )

    if tables == 0 and ledger_mode:
        violations.append(
            "  표를 하나도 찾지 못했다 — 원장에는 표가 있어야 한다. "
            "검사가 조용히 아무것도 하지 않는 상태이므로 위반으로 보고한다"
        )

    return violations, warnings


def gated_files() -> list[Path]:
    """검사 대상. 원장이 목록에 없으면(파일 부재) 그것부터 실패시킨다."""
    return sorted(ROOT.glob(GATED_GLOB))


def run_check() -> int:
    if not LEDGER.exists():
        _stderr(f"[원장 표 게이트] 원장을 찾을 수 없다: {LEDGER}")
        return 1

    all_violations: list[str] = []
    files = gated_files()
    total_tables = 0
    total_ledger_tables = 0

    for path in files:
        rel = path.relative_to(ROOT).as_posix()
        # 원장 규약(상태 열·최소 표 수)은 원장에만. 다른 문서는 열 구성이 다르고
        # 표가 아예 없는 파일도 있어 표 구조만 본다(원장 26al).
        ledger_mode = path.resolve() == LEDGER.resolve()
        stats: dict = {}
        violations, warnings = check_text(
            path.read_text(encoding="utf-8"),
            ledger_mode=ledger_mode,
            stats=stats,
            min_ledger_tables=MIN_LEDGER_TABLES if ledger_mode else 0,
        )
        total_tables += stats.get("tables", 0)
        total_ledger_tables += stats.get("ledger_tables", 0)
        for warn in warnings:
            print(f"[원장 표 게이트] 경고 {rel}:\n{warn}")
        all_violations.extend(f"  {rel} {v.strip()}" for v in violations)

    if all_violations:
        _stderr(
            "[원장 표 게이트] 표 무결성 위반 %d건:\n%s\n"
            "파이프를 셀 안에 넣으려면 **백슬래시 하나**를 앞에 붙인다 — "
            "이중 백슬래시는 코드 스팬 안에서 백슬래시가 노출되고, "
            "`%s`는 코드 스팬 안에서 디코딩되지 않는다(2026-07-30 실측)."
            % (len(all_violations), "\n".join(all_violations), HTML_PIPE_ENTITY)
        )
        return 1
    # 몇 개를 봤는지 함께 찍는다 — 침묵을 커버리지로 오해하지 않도록.
    # 계수는 `check_text`가 **실제로 검사한 것**을 그대로 받는다. 별도 방법으로
    # 세면 들여쓴 표를 놓쳐 실제보다 적게 찍힌다(2회차 minor 6).
    print("[원장 표 게이트] 위반 0건 (파일 %d개 · 표 %d개 · 원장 규약 표 %d개 검사)."
          % (len(files), total_tables, total_ledger_tables))
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
    rel = _gated_path(file_path)
    if rel is None:
        return 0

    problems: list[str] = []

    # Write는 전문을 주므로 표 구조까지 볼 수 있다(리뷰 minor 6 — 열 수 부족
    # 형태가 편집 시점에 통과하던 구멍). Edit 조각에는 적용하지 않는다.
    content = tool_input.get("content")
    if isinstance(content, str):
        violations, _ = check_text(content, ledger_mode=(rel == "harness/progress.md"))
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


def _gated_path(path_str: str) -> str | None:
    """검사 대상이면 저장소 상대 경로를, 아니면 None. 기존 훅과 같게 정규화한다.

    접미사 일치(`endswith`)를 쓰면 프로젝트 밖의 동명 파일이나
    `xharness/progress.md`도 걸린다(리뷰 minor 7).
    """
    if not isinstance(path_str, str) or not path_str:
        return None  # payload가 문자열이 아닐 때 AttributeError로 죽지 않는다
    p = Path(path_str.replace("\\", "/"))
    try:
        rel = p.resolve().relative_to(ROOT) if p.is_absolute() else p
    except (ValueError, OSError):
        return None  # 프로젝트 밖 경로는 이 게이트의 관할이 아니다
    posix = rel.as_posix()
    if not posix.startswith("harness/") or not posix.endswith(".md"):
        return None
    return posix


def _is_ledger_path(path_str: str) -> bool:
    """원장 자신인가. 원장 규약(상태 열·최소 표 수)은 여기에만 적용된다."""
    return _gated_path(path_str) == "harness/progress.md"


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
        # 델타 재평가 major 1 — 파손 없이 헤더만 개명하면 상태 열 검사가 조용히
        # 꺼진다. 표가 여럿일 때 **다른 표가 카운터를 채워** 무성 통과하던 구멍이다.
        ("표 하나만 헤더 개명(파손 없음 — 다른 표가 정상이어도 잡아야 한다)",
         table("| 1 | **a** | RQ-01 | ✅ | `f` | b |") + "\n\n산문\n\n"
         + "| No | 작업 | 관련 | 상태 | 참조 | 비고 |\n" + sep
         + "\n| 2 | **c** | RQ-02 | ⬜ | `g` | d |"),
        # 2회차 minor 2 — 열을 끼워 상태 열을 밀면 검사 3종이 다른 열로 옮겨간다.
        ("`순번` 표에 열을 끼워 상태 열이 밀렸다",
         "| 순번 | 분류 | 작업 | 관련 | 상태 | 참조 | 비고 |\n|---|---|---|---|---|---|---|\n"
         + "| 1 | x | **a** | RQ-01 | ✅ | `f` | b |"),
        # 2회차 minor 3 — GFM이 코드 블록으로 읽어 실제로 행을 잃는다.
        ("표 행이 4칸 들여쓰여 있다",
         table("| 1 | **a** | RQ-01 | ✅ | `f` | b |")
         + "\n    | 2 | **c** | RQ-02 | ⬜ | `g` | d |"),
        ("표 행이 탭으로 들여쓰여 있다",
         table("| 1 | **a** | RQ-01 | ✅ | `f` | b |")
         + "\n\t| 2 | **c** | RQ-02 | ⬜ | `g` | d |"),
        ("상태 열 어휘가 알 수 없는 값",
         table("| 9z | **제목** | RQ-01 | 진행중 | `파일` | 비고 |")),
        ("상태 열이 빈 칸(렌더는 정상, 집계에서만 빠진다)",
         table("| 9y | **제목** | RQ-01 |  | `파일` | 비고 |")),
        ("표가 하나도 없다(검사가 무성 통과하지 않는다)", "표가 없는 산문뿐이다\n"),
        # 26al ① — GFM이 별개 행으로 흡수해 뒷문장이 첫 칸으로 밀린다.
        # 실측: `adr/0004`의 "공중 가속" 행이 이 형태로 깨져 있었다.
        ("표 안의 선행 파이프 없는 행(두 줄로 쪼개진 셀)",
         table("| 1 | **a** | RQ-01 | ✅ | `f` | 공중에서는 점프")
         + "\n  이함 시점의 수평 관성만 유지 |"),
        # 26al ⑤ — 코드 스팬 안 맨 파이프는 표 행에서 잡는다.
        ("표 행의 코드 스팬 안 맨 파이프",
         table("| 28a | **제목** | RQ-04 | ✅ | `브랜치` | `a || b` 이다 |")),
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
        ("정렬 표기 구분선",
         header + "\n|:---|:---:|---:|---|---|---|\n| 1 | **a** | RQ-01 | ✅ | `f` | b |"),
        ("3칸 이하 들여쓴 표 행(GFM 허용 — 오탐 금지)",
         "  " + header + "\n  " + sep + "\n  | 1 | **a** | RQ-01 | ✅ | `f` | b |"),
        # 2회차 minor 1 — 원장 안의 열 구성이 다른 부록 표. GFM은 정상 렌더한다.
        ("원장에 열 구성이 다른 부록 표(오탐 금지)",
         table("| 1 | **a** | RQ-01 | ✅ | `f` | b |") + "\n\n산문\n\n"
         + "| 날짜 | 내용 |\n|---|---|\n| 2026-07-30 | x |"),
        # 26al ② — 코드 펜스 안의 파이프는 표가 아니다. 펜스 안에 일부러
        # 깨진 표를 넣어 둔다 — 인식하면 위반 0건, 못 하면 쏟아진다.
        ("코드 펜스 안의 표 형태(오탐 금지)",
         table("| 1 | **a** | RQ-01 | ✅ | `f` | b |") + "\n\n"
         + "```\n| 깨진 | 표 |\n| 열 수가 | 안 맞는다 | 더 |\n```\n"),
        ("물결 펜스도 인식한다(오탐 금지)",
         table("| 1 | **a** | RQ-01 | ✅ | `f` | b |") + "\n\n"
         + "~~~\n| 깨진 | 표 | 더 |\n~~~\n"),
        # 26al — 산문·블록쿼트의 코드 스팬은 표 행이 아니다. 파일 전체를 훑던
        # 이전 방식이 커버리지 확장 직후 낸 오탐이다(`infra/worker-crash-rca.md:12`).
        ("블록쿼트 산문의 코드 스팬 맨 파이프(오탐 금지)",
         table("| 1 | **a** | RQ-01 | ✅ | `f` | b |") + "\n\n"
         + '>   `"^20.19.0 || ^22.13.0"` + `check.sh` 런타임 가드다.\n'),
        ("표 밖 산문의 코드 스팬 맨 파이프(오탐 금지)",
         table("| 1 | **a** | RQ-01 | ✅ | `f` | b |")
         + "\n\nengines는 `^20.19.0 || ^22.13.0` 이다.\n"),
    ]

    # `ledger_mode=False`로만 통과해야 하는 것 — 원장이 아닌 파일을 검사할 때의
    # 형태다(원장 26al의 커버리지 확장이 이 모드를 쓴다).
    must_pass_generic = [
        ("열 구성이 다른 표만 있는 파일(changelog 형태 — 오탐 금지)",
         "| 날짜 | 변경 내용 | 대상 | 사유 |\n|---|---|---|---|\n"
         + "| 2026-07-30 | **x** | `f` | y |"),
        ("표가 없는 파일(evals/README 형태)", "표가 없는 산문뿐이다\n"),
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
    for name, text in must_pass_generic:
        violations, _ = check_text(text, ledger_mode=False)
        if violations:
            failed.append(f"오탐(generic) — {name}: {violations}")

    # 26al ④ — 개명과 열 수 변경을 함께 하면 두 검사를 모두 빠져나간다.
    # 최소 개수가 그 경로를 막는지 확인한다.
    renamed_and_reshaped = (
        "| No | 작업 | 관련 | 진행 | 참조 | 비고 | 부기 |\n"
        "|---|---|---|---|---|---|---|\n"
        "| 1 | **a** | RQ-01 | ✅ | `f` | b | c |"
    )
    v_min, _ = check_text(renamed_and_reshaped, min_ledger_tables=3)
    if not any("원장 규약 표가" in v for v in v_min):
        failed.append("최소 표 수 — 개명+열 수 변경이 두 검사를 빠져나가는데 막지 못했다")
    v_nomin, _ = check_text(renamed_and_reshaped)
    if any("원장 규약 표가" in v for v in v_nomin):
        failed.append("최소 표 수 — 임계 0일 때 발화하면 안 된다")
    v_ok, _ = check_text(
        "\n\n".join(table(f"| {i} | **a** | RQ-01 | ✅ | `f` | b |") for i in range(3)),
        min_ledger_tables=3,
    )
    if any("원장 규약 표가" in v for v in v_ok):
        failed.append(f"최소 표 수 — 원장 규약 표 3개인데 오탐: {v_ok}")

    # 26al ⑤ — 구분선이 깨지면 그 표를 건너뛴다. 이어서 검사하면 데이터 행을
    # 헤더로 오진하며 진단이 쏟아져 첫 메시지가 묻힌다(실측 138건).
    broken_sep = header + "\n|---|---|---|\n" + "\n".join(
        f"| {i} | **a** | RQ-01 | ✅ | `f` | b |" for i in range(30)
    )
    v_cascade, _ = check_text(broken_sep)
    if len(v_cascade) != 1:
        failed.append(
            f"구분선 파손 — 진단이 1건이어야 하는데 {len(v_cascade)}건이다(소음): "
            f"{v_cascade[:3]}"
        )
    elif "구분선 열 수가 헤더와 다르다" not in v_cascade[0]:
        failed.append(f"구분선 파손 — 첫 진단이 원인을 지목하지 않는다: {v_cascade[0]}")

    # 건너뛰기가 **다음 표까지 삼키지 않는지**. 삼키면 이후 파손이 무검출이 된다.
    v_resume, _ = check_text(
        broken_sep + "\n\n산문\n\n" + table("| 9 | **a** | RQ-01 | ⬜ | `f` |")
    )
    if not any("열 수 부족" in v for v in v_resume):
        failed.append(f"구분선 파손 — 건너뛰기가 다음 표까지 삼켰다: {v_resume}")

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
    # 커버리지가 `harness/**/*.md`로 넓어졌으므로 두 판정을 나눠 검사한다:
    # `_gated_path`(검사 대상인가)와 `_is_ledger_path`(원장 규약을 적용하는가).
    path_cases = [
        (str(ROOT / "harness" / "progress.md"), True, True),
        ("harness/progress.md", True, True),
        (r"harness\progress.md", True, True),
        ("harness/changelog.md", True, False),
        ("harness/adr/0004-physics-collision.md", True, False),
        ("harness/evals/README.md", True, False),
        ("xharness/progress.md", False, False),
        ("src/shared/constants.ts", False, False),
        ("harness/evals/golden/track-a-product.jsonl", False, False),
        ("README.md", False, False),
        ("", False, False),
    ]
    for path, gated, is_ledger in path_cases:
        if (_gated_path(path) is not None) != gated:
            failed.append(f"경로 판정(검사 대상) — {path!r}: expected {gated}")
        if _is_ledger_path(path) != is_ledger:
            failed.append(f"경로 판정(원장) — {path!r}: expected {is_ledger}")

    # 글로브가 실제로 원장을 잡는가 — 목록이 비면 검사가 조용히 아무것도 안 한다.
    files = gated_files()
    if LEDGER not in files:
        failed.append("검사 대상 글로브가 원장을 잡지 못한다")
    if len(files) < 2:
        failed.append(f"검사 대상이 {len(files)}개뿐이다 — 글로브가 좁아졌는지 확인하라")

    if failed:
        _stderr("[원장 표 게이트 selftest] 실패 %d건:\n  %s"
                % (len(failed), "\n  ".join(failed)))
        return 1
    print("[원장 표 게이트 selftest] 통과 — 차단 %d건·허용 %d건·경로 %d건 확인."
          % (len(must_block) + len(hook_block),
             len(must_pass) + len(must_pass_generic) + len(hook_pass),
             len(path_cases)))
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
