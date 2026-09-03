import { createFileRoute } from "@tanstack/react-router";
import DemoListPage from "../components/DemoListPage";

export const Route = createFileRoute("/demo-pastdue")({
  component: DemoPastdue,
});

function DemoPastdue() {
  return <DemoListPage kind="pastdue" />;
}