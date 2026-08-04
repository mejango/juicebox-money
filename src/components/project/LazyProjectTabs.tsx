"use client";

import dynamic from "next/dynamic";

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
  { loading: () => null },
);
export const ExtrasTab = dynamic(() =>
  import("@/components/project/DeferredProjectTabs").then(
    (module) => module.ExtrasTab,
  ),
  { loading: () => null },
);
export const FundsTab = dynamic(() =>
  import("@/components/project/DeferredProjectTabs").then(
    (module) => module.FundsTab,
  ),
  { loading: () => null },
);
export const OwnersTab = dynamic(() =>
  import("@/components/project/DeferredProjectTabs").then(
    (module) => module.OwnersTab,
  ),
  { loading: () => null },
);
export const RulesetsTab = dynamic(() =>
  import("@/components/project/DeferredProjectTabs").then(
    (module) => module.RulesetsTab,
  ),
  { loading: () => null },
);
export const ShopTab = dynamic(() =>
  import("@/components/project/DeferredProjectTabs").then(
    (module) => module.ShopTab,
  ),
  { loading: () => null },
);
export const TermsTab = dynamic(() =>
  import("@/components/project/DeferredProjectTabs").then(
    (module) => module.TermsTab,
  ),
  { loading: () => null },
);
