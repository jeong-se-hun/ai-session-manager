# AI Session Manager

Codex, Claude Code, Gemini CLI의 로컬 세션 기록을 한 화면에서 보고 정리하는 로컬 전용 웹 UI입니다.

이 앱은 외부 서버로 대화 내용을 업로드하지 않습니다. 사용자의 PC에서만 실행되며, `127.0.0.1`에 떠 있는 로컬 서버가 로컬 기록 파일을 읽습니다.

## 주요 기능

- Codex / Claude Code / Gemini CLI 세션 통합 조회
- AI 도구별 필터링
- 프로젝트 경로 기준 조회
- 마지막 대화일, 생성일, 토큰, 파일 크기 기준 정렬
- 세션 상세 대화 보기
- Codex CLI 기반 세션 요약 생성
- Codex CLI를 사용할 수 없을 때 로컬 fallback 요약 제공
- 삭제 대기 이동 및 복구
- 실제 기록 파일 삭제
- 목록 정보와 원본 파일의 연결 상태 확인
- 토큰 사용량과 원본 파일 크기 표시

## 지원하는 기록 위치

기본적으로 아래 경로를 스캔합니다.

```txt
Codex:      ~/.codex
Claude:     ~/.claude
Gemini:     ~/.gemini
앱 데이터:  ~/.codex-session-manager
```

내 환경에서 기록 폴더가 다르면 환경변수로 직접 지정할 수 있습니다.

```bash
CODEX_HOME=/path/to/.codex
CLAUDE_HOME=/path/to/.claude
CLAUDE_CONFIG_DIR=/path/to/.claude
GEMINI_HOME=/path/to/.gemini
GEMINI_CLI_HOME=/path/to/.gemini
CODEX_SESSION_MANAGER_HOME=/path/to/app-data
```

`CLAUDE_HOME`이 없으면 `CLAUDE_CONFIG_DIR`을, `GEMINI_HOME`이 없으면 `GEMINI_CLI_HOME`을 사용합니다.

폴더를 직접 지정해야 한다면 아래 기준으로 찾으면 됩니다.

```txt
Codex 폴더
- 보통 ~/.codex
- 안에 state_5.sqlite, session_index.jsonl, history.jsonl, sessions 폴더가 있으면 맞습니다.

Claude 폴더
- 보통 ~/.claude
- 안에 projects, transcripts, settings.json, todos 폴더가 있으면 맞습니다.

Gemini 폴더
- 보통 ~/.gemini
- 안에 tmp, history, settings.json, oauth_creds.json 폴더가 있으면 맞습니다.
```

## OS 지원 상태

```txt
macOS:   테스트됨
Linux:   동작 예상
Windows: 실험적 지원
WSL:     환경변수로 Windows 쪽 기록 경로를 직접 지정하는 것을 권장
```

Windows 또는 WSL에서는 실제 CLI가 기록을 저장하는 위치가 다를 수 있습니다. 이 경우 `CODEX_HOME`, `CLAUDE_HOME` 또는 `CLAUDE_CONFIG_DIR`, `GEMINI_HOME` 또는 `GEMINI_CLI_HOME`을 직접 지정하세요.

## 설치

```bash
git clone https://github.com/jeong-se-hun/ai-session-manager.git
cd ai-session-manager
npm install
```

## 실행

개발/로컬 실행:

```bash
npm run app
```

브라우저에서 아래 주소를 엽니다.

```txt
http://127.0.0.1:3767
```

API 서버는 기본적으로 아래 주소에서 실행됩니다.

```txt
http://127.0.0.1:3766
```

처음 실행하면 앱이 현재 OS와 홈 디렉터리를 기준으로 Codex, Claude, Gemini 기록 폴더를 자동으로 찾습니다.

```txt
1. 추천 경로, 발견된 세션 수, 신뢰도 확인
2. 필요하면 경로 직접 수정
3. 저장 후 스캔
```

추천 신뢰도는 세션 파일 개수만 보지 않고 각 도구의 실제 저장 구조까지 같이 봅니다. 예를 들어 Codex는 `state_5.sqlite`와 `sessions`, Claude는 `projects`/`transcripts`, Gemini는 `tmp`/`history`/`checkpoints` 신호를 함께 확인합니다.

저장한 경로는 `~/.codex-session-manager/app.sqlite`에 보관됩니다. 이후에는 같은 경로를 다시 사용하며, 화면 상단의 `경로 설정` 버튼으로 언제든 변경할 수 있습니다.

## 빌드와 검증

```bash
npm run audit:app
npm audit --audit-level=high
git diff --check
```

`npm run audit:app`은 테스트와 빌드를 함께 실행합니다.

```bash
npm test
npm run build
```

## 요약 생성 방식

AI 요약은 현재 Codex CLI를 사용합니다.

```txt
세션 원문 읽기
→ Codex CLI를 headless로 실행
→ 전체 세션 흐름 기준 한국어 요약 생성
→ 실패 시 로컬 fallback 요약 저장
```

사용 가능한 환경변수:

```bash
CODEX_CLI_PATH=/path/to/codex
CODEX_SUMMARY_MODEL=gpt-5.2
CODEX_SUMMARY_TIMEOUT_MS=60000
```

Codex CLI가 설치되어 있지 않거나 인증되지 않은 경우에도 앱은 멈추지 않고 fallback 요약을 사용합니다.

## 삭제 기능 주의

이 앱에는 실제 로컬 AI 기록 파일을 삭제하는 기능이 있습니다.

삭제 동작은 두 단계로 나뉩니다.

```txt
삭제 대기
- 원본 기록 파일은 삭제하지 않습니다.
- 앱 내부에 삭제 대기 상태와 복구용 사본을 기록합니다.
- 복구할 수 있습니다.

삭제
- 선택한 AI의 실제 기록 파일을 삭제합니다.
- Codex는 관련 목록 DB, 로그 DB, history/index 기록도 함께 정리합니다.
- 복구할 수 없습니다.
```

최근 30분 이내에 갱신된 세션은 실행 중일 수 있으므로 삭제를 건너뜁니다.

## 기록 상태 확인이란?

AI 도구의 목록 정보와 실제 원본 파일이 서로 맞는지 확인하는 기능입니다.

예를 들어 다음 상태를 확인합니다.

- 목록에는 세션이 있는데 원본 파일이 없는 경우
- 원본 파일은 있는데 목록 DB에 연결되지 않은 경우
- 삭제 대기 항목이 남아 있는 경우
- Codex / Claude / Gemini 기록 폴더가 없는 경우

Codex는 특히 목록 DB와 원본 JSONL 파일이 따로 있습니다.

```txt
목록 정보: ~/.codex/state_5.sqlite
원본 대화: ~/.codex/sessions/**/rollout-*.jsonl
```

이 둘이 어긋나면 목록에는 보이지만 상세가 비거나, 파일은 남아 있지만 앱 목록에는 안 보일 수 있습니다.

## 보안과 개인정보

- 로컬 파일만 읽습니다.
- 외부 서버로 세션 내용을 업로드하지 않습니다.
- 브라우저와 API 서버는 기본적으로 `127.0.0.1`에만 바인딩됩니다.
- 삭제 기능은 실제 파일을 지우므로 공개 서버나 공유 환경에서 실행하지 마세요.

## 개발 메모

주요 스크립트:

```bash
npm run app          # API 서버와 Vite UI 동시 실행
npm run dev:server   # API 서버만 watch 실행
npm run dev:web      # Vite UI만 실행
npm run server       # API 서버 실행
npm test             # Vitest
npm run typecheck    # TypeScript 검사
npm run build        # Vite client build
npm run audit:app    # test + build
```

기술 스택:

- React
- Vite
- Fastify
- TypeScript
- better-sqlite3
- Vitest

## 비공식 도구

이 프로젝트는 OpenAI, Anthropic, Google의 공식 제품이 아닙니다. 각 CLI의 로컬 기록 저장 구조가 바뀌면 스캔 로직이 깨질 수 있습니다.

## 라이선스

`package.json` 기준 MIT 라이선스를 사용합니다. 별도 `LICENSE` 파일은 추후 추가 예정입니다.
