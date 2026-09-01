import { useFetch } from "./useFetch";

/**
 * Says what a hosted demo is, and — more importantly — what it is not.
 *
 * The server decides, not the build: `/health` reports `demo`, so ONE artefact runs
 * everywhere. A build-time flag would mean two builds and a way to ship the wrong one.
 *
 * The wording matters more than the styling. Someone landing on a finance app has exactly
 * two questions — *is this my data?* and *can other people see what I do here?* — and both
 * answers here are uncomfortable enough to state before they click anything: the data is
 * generated, there is no login, and everyone shares one database.
 */
export default function DemoBanner() {
  // A single cheap call, and no `revalidateOn`: whether this process is a demo cannot
  // change while the page is open.
  const health = useFetch<{ ok: boolean; demo: boolean }>("/health");
  if (!health.data?.demo) return null;

  return (
    <div className="demo-banner" role="status">
      <strong>Demo.</strong> Generated data, so you can try it before setting anything up —
      nothing here is real money. <strong>There is no sign-in:</strong> one shared database,
      anything you change everyone sees, and it may be reset at any time.{" "}
      <strong>Do not enter real financial details.</strong>{" "}
      <a href="https://github.com/Shekhar-Dangi/khata#running-it">Run it locally</a> to use
      your own statements — which never leave your machine, and is the point.
    </div>
  );
}
