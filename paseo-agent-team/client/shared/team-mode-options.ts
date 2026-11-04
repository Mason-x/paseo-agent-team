import { zh } from "../../shared/zh";

// The team mode, the Role tier and the task kind are retired (.notes/274), so the picker tables
// that served them are gone. What is left is the member-creation choice, which is not retired.

export type MemberCreation = "" | "eager" | "on-demand";

export const MEMBER_CREATION_OPTIONS: readonly { value: MemberCreation; label: string }[] = [
  { value: "", label: zh.memberCreationDefault },
  { value: "eager", label: zh.memberCreationEager },
  { value: "on-demand", label: zh.memberCreationOnDemand },
];
