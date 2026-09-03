import { createFileRoute } from "@tanstack/react-router";
import DemoListPage from "../components/DemoListPage";

export const Route = createFileRoute("/demo-reminders")({
  component: DemoReminders,
});

function DemoReminders() {
  return <DemoListPage kind="reminders" />;
}