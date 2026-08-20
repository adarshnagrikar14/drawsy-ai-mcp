import {
  isConnectorCapability,
  isRecord,
  type HydraContextSource
} from "./protocol.js";

const hydraSourceText = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const hydraCapabilityFromValue = (
  value: unknown
): HydraContextSource["capability"] => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (isConnectorCapability(normalized)) return normalized;
  if (/\b(read[\s-]?ai)\b/.test(normalized)) return "read-ai";
  if (/\b(fireflies)\b/.test(normalized)) return "fireflies";
  if (/\b(google[\s-]?workspace|gmail|email|mail)\b/.test(normalized)) {
    return "mail";
  }
  if (/\b(google[\s-]?calendar|calendar|event)\b/.test(normalized)) {
    return "calendar";
  }
  if (/\b(google[\s-]?drive|drive|file)\b/.test(normalized)) {
    return "drive";
  }
  if (/\b(notion|page)\b/.test(normalized)) return "notion";
  if (/\b(slack|channel)\b/.test(normalized)) return "slack";
  if (/\b(github|repository|repo|pull[\s-]?request|issue)\b/.test(normalized)) {
    return "github";
  }
  if (/\b(aws|cloudformation|infrastructure|region)\b/.test(normalized)) {
    return "aws";
  }
  return null;
};

const hydraSourceLabel = (value: unknown, kind: HydraContextSource["kind"]) => {
  const text = hydraSourceText(value);
  if (!text) return kind === "memory" ? "Personal memory" : "Connected source";
  return text
    .replace(/^drawsy_[^_]+_/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .slice(0, 160);
};

const hydraContextSources = (
  sourceEntries: unknown[],
  chunkEntries: unknown[]
): HydraContextSource[] => {
  const parseEntries = (entries: unknown[]) => {
    const sources: HydraContextSource[] = [];
    const seen = new Set<string>();

    for (const entry of entries) {
      if (!isRecord(entry)) continue;

      const value = isRecord(entry.sourceInfo)
        ? entry.sourceInfo
        : isRecord(entry.source_info)
        ? entry.source_info
        : isRecord(entry.chunk)
        ? entry.chunk
        : isRecord(entry.source)
        ? entry.source
        : entry;

      const metadataValues = [
        value.metadata,
        value.additionalMetadata,
        value.documentMetadata,
        value.tenantMetadata,
        value.additional_metadata,
        value.document_metadata,
        value.tenant_metadata
      ].filter(isRecord);

      const kindCandidates = [
        entry.kind,
        entry.sourceKind,
        entry.source_kind,
        entry.source,
        value.kind,
        value.sourceKind,
        value.source_kind,
        value.source,
        ...metadataValues.flatMap((metadata) => [
          metadata.kind,
          metadata.sourceKind,
          metadata.source_kind,
          metadata.source
        ])
      ];
      const kind: HydraContextSource["kind"] = kindCandidates.some((candidate) => {
        const normalized = hydraSourceText(candidate)?.toLowerCase();
        return (
          normalized === "memory" ||
          normalized?.includes("personal memory") === true
        );
      })
        ? "memory"
        : "connector";

      const id = [
        value.source_id,
        value.sourceId,
        value.id,
        value.chunk_uuid,
        value.chunkUuid,
        value.record_id,
        value.recordId,
        value.external_id,
        value.externalId,
        value.app_external_id,
        value.appExternalId,
        value.document_id,
        value.documentId
      ]
        .map(hydraSourceText)
        .find(Boolean);
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const capability = [
        value.capability,
        value.app_provider,
        value.appProvider,
        value.provider_id,
        value.providerId,
        value.provider,
        value.app_kind,
        value.appKind,
        value.source_provider,
        value.sourceProvider,
        value.source_type,
        value.sourceType,
        value.type,
        value.kind,
        ...metadataValues.flatMap((metadata) => [
          metadata.capability,
          metadata.app_provider,
          metadata.appProvider,
          metadata.provider_id,
          metadata.providerId,
          metadata.provider,
          metadata.app_kind,
          metadata.appKind,
          metadata.source_provider,
          metadata.sourceProvider,
          metadata.source_type,
          metadata.sourceType,
          metadata.type
        ])
      ]
        .map(hydraCapabilityFromValue)
        .find((candidate) => candidate !== null) || null;

      sources.push({
        id,
        kind,
        capability,
        label: hydraSourceLabel(
          value.source_title ||
            value.sourceTitle ||
            value.source_name ||
            value.sourceName ||
            value.title ||
            value.name ||
            value.source_type ||
            value.sourceType ||
            value.type ||
            value.kind,
          kind
        )
      });
    }

    return sources;
  };

  const sources = parseEntries(sourceEntries);
  return (sources.length ? sources : parseEntries(chunkEntries)).slice(0, 12);
};

export { hydraContextSources };
