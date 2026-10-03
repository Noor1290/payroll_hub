import { z } from "zod";
import type { ExpectedField } from "@/config/apps.config";
import { preferenceStorage } from "@/lib/storage";
import { createStore } from "@/lib/store";
import type { Mapping, SourceColumn } from "./mapping";

/**
 * Saved column mappings, e.g. "Payroll -> Payslip". A template holds column NAMES only
 * (which source column feeds which destination field). It never holds a payroll value, so it
 * is safe to keep in localStorage.
 */
const templateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(60),
  /** App id the mapping is for. */
  destinationId: z.string().min(1),
  dataType: z.string().min(1),
  /** destination field key -> source column key */
  mapping: z.record(z.string().max(120), z.string().max(120)),
  savedAt: z.string(),
});
export type MappingTemplate = z.infer<typeof templateSchema>;

const STORAGE_KEY = "mapping-templates";
const MAX_TEMPLATES = 50;

function read(): MappingTemplate[] {
  try {
    const parsed = z
      .array(templateSchema)
      .safeParse(JSON.parse(preferenceStorage.getItem(STORAGE_KEY) ?? "[]"));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export const mappingTemplates = createStore<MappingTemplate[]>(read());

function write(templates: MappingTemplate[]): void {
  preferenceStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
  mappingTemplates.set(templates);
}

/** Saves a mapping under a name. Saving again with the same name and destination replaces it. */
export function saveTemplate(input: {
  name: string;
  destinationId: string;
  dataType: string;
  mapping: Mapping;
}): MappingTemplate | null {
  const name = input.name.trim().slice(0, 60);
  if (!name) return null;
  // Only non-empty name -> name pairs. Nothing else can get into storage through here.
  const mapping = Object.fromEntries(
    Object.entries(input.mapping).filter(([target, source]) => target && source),
  );
  const template: MappingTemplate = {
    id: `${input.destinationId}:${name.toLowerCase()}`,
    name,
    destinationId: input.destinationId,
    dataType: input.dataType,
    mapping,
    savedAt: new Date().toISOString(),
  };
  const others = mappingTemplates.get().filter((existing) => existing.id !== template.id);
  write([template, ...others].slice(0, MAX_TEMPLATES));
  return template;
}

export function deleteTemplate(id: string): void {
  write(mappingTemplates.get().filter((template) => template.id !== id));
}

/**
 * Turns a template into a mapping for the data at hand: entries for fields the destination no
 * longer has, or columns the source doesn't have, are left out rather than guessed.
 */
export function applyTemplate(
  template: MappingTemplate,
  columns: readonly SourceColumn[],
  fields: readonly ExpectedField[],
): Mapping {
  const available = new Set(columns.map((column) => column.key));
  const mapping: Mapping = {};
  for (const field of fields) {
    const source = template.mapping[field.key];
    if (source && available.has(source)) mapping[field.key] = source;
  }
  return mapping;
}
