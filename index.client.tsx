import type { PluginClientContext } from "@getpaseo/plugin/client";
import { LiveZhPanel } from "./client/panel";
import { PANEL_ID, contributePills } from "./client/pills";
import { LiveZhSettingsScreen } from "./client/settings";

const SETTINGS_ID = "settings";

export default function contribute(client: PluginClientContext) {
  const stopPills = contributePills(client);

  const stopPanel = client.addWorkspacePanel({
    id: PANEL_ID,
    title: "中文解说",
    icon: "Languages",
    locations: ["explorer", "workspace"],
    Component: (props) => (
      <LiveZhPanel {...props} openSettings={() => client.openSettings(SETTINGS_ID)} />
    ),
  });

  const stopSettings = client.addSettingsScreen({
    id: SETTINGS_ID,
    title: "实时中文解说",
    icon: "Languages",
    Component: LiveZhSettingsScreen,
  });

  const stopOpenPanelCmd = client.addCommandCenterItem({
    id: "open-live-zh",
    title: "打开实时中文解说面板",
    icon: "Languages",
    keywords: ["translate", "chinese", "summary", "zh", "中文", "翻译", "解说"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel(PANEL_ID, { location: "explorer" });
    },
  });

  const stopOpenSettingsCmd = client.addCommandCenterItem({
    id: "open-live-zh-settings",
    title: "配置实时中文解说 API",
    icon: "Settings",
    keywords: ["translate", "api", "chinese", "opencode", "设置", "中文解说"],
    context: "global",
    onSelect({ openSettings }) {
      openSettings(SETTINGS_ID);
    },
  });

  return () => {
    void stopOpenSettingsCmd();
    void stopOpenPanelCmd();
    void stopSettings();
    void stopPanel();
    stopPills();
  };
}
