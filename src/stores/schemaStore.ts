import { create } from 'zustand';

const pendingAttributeLoads = new Map<string, Promise<void>>();

export interface EntityInfo {
    logicalName: string;
    displayName: string;
    entitySetName: string;
}

export interface AttributeInfo {
    logicalName: string;
    displayName: string;
    attributeType: string;
}

interface SchemaState {
    entities: EntityInfo[];
    attributes: Map<string, AttributeInfo[]>;
    loading: boolean;
    error: string | null;
    loadEntities: () => Promise<void>;
    loadAttributes: (entityLogicalName: string) => Promise<void>;
    getEntityByName: (name: string) => EntityInfo | undefined;
    reset: () => void;
}

export const useSchemaStore = create<SchemaState>((set, get) => ({
    entities: [],
    attributes: new Map(),
    loading: false,
    error: null,

    loadEntities: async () => {
        set({ loading: true, error: null });
        try {
            const result = await window.dataverseAPI.getAllEntitiesMetadata([
                'LogicalName',
                'DisplayName',
                'EntitySetName',
            ]);

            const entities: EntityInfo[] = result.value.map((raw) => {
                const logicalName = (raw['LogicalName'] as string) ?? '';
                const displayNameObj = raw['DisplayName'] as { LocalizedLabels?: Array<{ Label: string }> } | undefined;
                const displayName = displayNameObj?.LocalizedLabels?.[0]?.Label ?? logicalName;
                const entitySetName = (raw['EntitySetName'] as string) ?? '';

                return { logicalName, displayName, entitySetName };
            });

            entities.sort((a, b) => a.logicalName.localeCompare(b.logicalName));

            set({ entities, loading: false });
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to load entities';
            set({ loading: false, error: message });
        }
    },

    loadAttributes: (entityLogicalName: string): Promise<void> => {
        if (get().attributes.has(entityLogicalName)) {
            return Promise.resolve();
        }

        const existing = pendingAttributeLoads.get(entityLogicalName);
        if (existing) return existing;

        const promise = (async () => {
            try {
                const result = await window.dataverseAPI.getEntityRelatedMetadata(entityLogicalName, 'Attributes', [
                    'LogicalName',
                    'DisplayName',
                    'AttributeType',
                ]);

                const collection = result as { value: Record<string, unknown>[] };

                const attrs: AttributeInfo[] = collection.value.map((raw) => {
                    const logicalName = (raw['LogicalName'] as string) ?? '';
                    const displayNameObj = raw['DisplayName'] as
                        | { LocalizedLabels?: Array<{ Label: string }> }
                        | undefined;
                    const displayName = displayNameObj?.LocalizedLabels?.[0]?.Label ?? logicalName;
                    const attributeType = (raw['AttributeType'] as string) ?? '';

                    return { logicalName, displayName, attributeType };
                });

                const updatedAttributes = new Map(get().attributes);
                updatedAttributes.set(entityLogicalName, attrs);

                set({ attributes: updatedAttributes });
            } catch (err) {
                const message =
                    err instanceof Error ? err.message : `Failed to load attributes for ${entityLogicalName}`;
                set({ error: message });
            } finally {
                pendingAttributeLoads.delete(entityLogicalName);
            }
        })();

        pendingAttributeLoads.set(entityLogicalName, promise);
        return promise;
    },

    getEntityByName: (name: string) => {
        const { entities } = get();
        const lower = name.toLowerCase();
        return entities.find((e) => e.logicalName.toLowerCase() === lower);
    },

    reset: () => {
        set({
            entities: [],
            attributes: new Map(),
            loading: false,
            error: null,
        });
    },
}));
