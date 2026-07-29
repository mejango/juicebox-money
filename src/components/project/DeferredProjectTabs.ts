"use client";

// One shared async boundary avoids duplicating the SDK and transaction
// utilities across a separate chunk for every secondary project tab.
export { BackOfficeTab } from "@/components/project/BackOfficeTab";
export { ExtrasTab } from "@/components/project/ExtrasTab";
export { FundsTab } from "@/components/project/FundsTab";
export { OwnersTab } from "@/components/project/OwnersTab";
export { RulesetsTab } from "@/components/project/RulesetsTab";
export { ShopTab } from "@/components/project/ShopTab";
export { TermsTab } from "@/components/project/TermsTab";
