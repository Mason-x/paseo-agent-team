import { useState } from "react";
import type { PluginLayout, PluginTheme } from "../shared/theme";
import { useVersion } from "./use-version";
import { VersionButton } from "./VersionButton";
import { VersionPanel } from "./VersionPanel";

/** One host's version entry. Keyed by hostId so switching hosts never reuses another host's job. */
export function VersionEntry({
  theme,
  layout,
  hostId,
}: {
  theme: PluginTheme;
  layout: PluginLayout;
  hostId: string;
}) {
  const version = useVersion(hostId);
  const [open, setOpen] = useState(false);
  return (
    <>
      <VersionButton
        theme={theme}
        layout={layout}
        info={version.info}
        job={version.job}
        onOpen={() => {
          setOpen(true);
          version.refresh();
        }}
      />
      <VersionPanel
        theme={theme}
        layout={layout}
        open={open}
        info={version.info}
        job={version.job}
        loading={version.loading}
        checking={version.checking}
        starting={version.starting}
        reconnecting={version.reconnecting}
        recovering={version.recovering}
        checkError={version.checkError}
        startBlockers={version.startBlockers}
        onCheck={version.checkNow}
        onUpdate={version.startUpdate}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
