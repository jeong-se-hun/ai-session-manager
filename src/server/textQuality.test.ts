import { describe, expect, it } from "vitest";
import { pickDisplayTitle, summarizeTextFragment } from "./textQuality";

describe("session text quality helpers", () => {
  it("keeps real summary-related user requests", () => {
    expect(pickDisplayTitle(["Summary 기능 개선해줘"], "fallback")).toBe("Summary 기능 개선해줘");
  });

  it("skips technical continuation text and uses the next meaningful line", () => {
    const title = pickDisplayTitle(
      [
        "This session is being continued from a previous conversation that ran out of context.",
        "Primary Request and Intent: older internal note",
        "전체적인 요약으로 다시 수정해줘"
      ],
      "fallback"
    );
    expect(title).toBe("전체적인 요약으로 다시 수정해줘");
  });

  it("summarizes fragments without CSS-style geometry noise", () => {
    expect(
      summarizeTextFragment("width: 133.5; height: 63; opacity: 1;\n사원 선택 화면을 Figma 기준으로 검토해줘")
    ).toBe("사원 선택 화면을 Figma 기준으로 검토해줘");
  });

  it("cuts pasted specs after the actual user request", () => {
    const title = pickDisplayTitle(
      [
        "마이페이지 api 관련 수정 할건데 우선 수정하지말고 현재 적용된것과 다른것만 간단하게 핵심만 길지 않게 분석 후 정리해줘 # 📋 SEAMARQ 사용자 화면 마이페이지 API 명세서 v1.1 작성일 2026-05-19"
      ],
      "fallback"
    );
    expect(title).toContain("정리해줘");
    expect(title).not.toContain("API 명세서");
    expect(title.length).toBeLessThan(110);
  });

  it("cuts long planning requests at the command phrase", () => {
    const title = pickDisplayTitle(
      [
        "코덱스 세션 관리, 요약, 삭제, 필터링으로 코덱스의 세션 관리하고 지울수있는 프로그램 만들건데 계획 세워죠 어떤 기술들로 할거고 어떤 기능들을 가지고 있을거고 어떻게 만들지 미리 분석 하고 등"
      ],
      "fallback"
    );
    expect(title).toContain("계획 세워죠");
    expect(title).not.toContain("어떤 기술들");
  });
});
