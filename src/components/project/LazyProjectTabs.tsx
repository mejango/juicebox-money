"use client";

import dynamic from "next/dynamic";
import {
  ActionRowsSkeleton,
  FundsTabSkeleton,
  HolderDistributionSkeleton,
  RulesetsTabSkeleton,
  ShopTabSkeleton,
  TermsTabSkeleton,
} from "@/components/LoadingSkeletons";

// ProjectTabs only mounts a panel after the user selects it. Declaring these
// boundaries in a Client Component lets Next emit real on-demand chunks for
// the secondary read/write surfaces instead of folding them into the initial
// project route. Each explicit loading renderer also creates a local Suspense
// boundary; without it, a first-open chunk falls through to [urn]/loading.tsx
// and briefly replaces the entire mounted project with its route skeleton.
export const BackOfficeTab = dynamic(() =>
  import("@/components/project/DeferredProjectTabs").then(
    (module) => module.BackOfficeTab,
  ),
  { loading: () => <ActionRowsSkeleton label="Loading back office" /> },
);
export const ExtrasTab = dynamic(() =>
  import("@/components/project/DeferredProjectTabs").then(
    (module) => module.ExtrasTab,
  ),
  { loading: () => <ActionRowsSkeleton label="Loading extras" /> },
);
export const FundsTab = dynamic(() =>
  import("@/components/project/DeferredProjectTabs").then(
    (module) => module.FundsTab,
  ),
  { loading: () => <FundsTabSkeleton /> },
);
export const OwnersTab = dynamic(() =>
  import("@/components/project/DeferredProjectTabs").then(
    (module) => module.OwnersTab,
  ),
  { loading: () => <HolderDistributionSkeleton /> },
);
export const RulesetsTab = dynamic(() =>
  import("@/components/project/DeferredProjectTabs").then(
    (module) => module.RulesetsTab,
  ),
  { loading: () => <RulesetsTabSkeleton /> },
);
export const ShopTab = dynamic(() =>
  import("@/components/project/DeferredProjectTabs").then(
    (module) => module.ShopTab,
  ),
  { loading: () => <ShopTabSkeleton /> },
);
export const TermsTab = dynamic(() =>
  import("@/components/project/TermsTab").then(
    (module) => module.TermsTab,
  ),
  { loading: () => <TermsTabSkeleton /> },
);
