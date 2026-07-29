"use client";

import dynamic from "next/dynamic";

// ProjectTabs only mounts a panel after the user selects it. Declaring these
// boundaries in a Client Component lets Next emit real on-demand chunks for
// the secondary read/write surfaces instead of folding them into the initial
// project route.
export const BackOfficeTab = dynamic(() =>
  import("@/components/project/DeferredProjectTabs").then(
    (module) => module.BackOfficeTab,
  ),
);
export const ExtrasTab = dynamic(() =>
  import("@/components/project/DeferredProjectTabs").then(
    (module) => module.ExtrasTab,
  ),
);
export const FundsTab = dynamic(() =>
  import("@/components/project/DeferredProjectTabs").then(
    (module) => module.FundsTab,
  ),
);
export const OwnersTab = dynamic(() =>
  import("@/components/project/DeferredProjectTabs").then(
    (module) => module.OwnersTab,
  ),
);
export const RulesetsTab = dynamic(() =>
  import("@/components/project/DeferredProjectTabs").then(
    (module) => module.RulesetsTab,
  ),
);
export const ShopTab = dynamic(() =>
  import("@/components/project/DeferredProjectTabs").then(
    (module) => module.ShopTab,
  ),
);
export const TermsTab = dynamic(() =>
  import("@/components/project/DeferredProjectTabs").then(
    (module) => module.TermsTab,
  ),
);
