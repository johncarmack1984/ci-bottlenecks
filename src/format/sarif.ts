import type { Finding, Rule, Severity } from "../types.ts";
import { VERSION } from "../version.ts";

const SEVERITY_TO_LEVEL: Record<Severity, string> = {
  high: "error",
  medium: "warning",
  low: "note",
  info: "note",
};

interface SarifReport {
  $schema: string;
  version: string;
  runs: SarifRun[];
}

interface SarifRun {
  tool: { driver: SarifDriver };
  results: SarifResult[];
}

interface SarifDriver {
  name: string;
  version: string;
  informationUri: string;
  rules: SarifRuleDescriptor[];
}

interface SarifRuleDescriptor {
  id: string;
  shortDescription: { text: string };
  helpUri?: string;
  defaultConfiguration: { level: string };
  properties?: Record<string, unknown>;
}

interface SarifResult {
  ruleId: string;
  level: string;
  message: { text: string };
  locations?: SarifLocation[];
  properties?: Record<string, unknown>;
}

interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string };
    region?: { startLine: number; startColumn?: number };
  };
}

export function formatSarif(findings: Finding[], rules: Rule[]): SarifReport {
  const ruleDescriptors: SarifRuleDescriptor[] = rules.map((r) => ({
    id: r.id,
    shortDescription: { text: r.describe },
    defaultConfiguration: { level: SEVERITY_TO_LEVEL[r.severity] },
    properties: {
      tier: r.tier,
      ...(r.pedantic ? { pedantic: true } : {}),
    },
  }));

  const results: SarifResult[] = findings.map((f) => {
    const result: SarifResult = {
      ruleId: f.rule,
      level: SEVERITY_TO_LEVEL[f.severity],
      message: {
        text: `${f.message}\n\nEvidence: ${f.evidence}\n\nRemediation: ${f.remediation}`,
      },
    };

    if (f.location) {
      result.locations = [
        {
          physicalLocation: {
            artifactLocation: { uri: f.workflow },
            region: {
              startLine: f.location.line,
              ...(f.location.column
                ? { startColumn: f.location.column }
                : {}),
            },
          },
        },
      ];
    } else if (f.workflow) {
      result.locations = [
        {
          physicalLocation: {
            artifactLocation: { uri: f.workflow },
          },
        },
      ];
    }

    if (f.estimatedSavings) {
      result.properties = { estimatedSavings: f.estimatedSavings };
    }

    return result;
  });

  return {
    $schema:
      "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "ci-bottlenecks",
            version: VERSION,
            informationUri:
              "https://github.com/johncarmack1984/ci-bottlenecks",
            rules: ruleDescriptors,
          },
        },
        results,
      },
    ],
  };
}
