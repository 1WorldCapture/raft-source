package runtimecatalog

import (
	"encoding/json"
	"strings"
)

// ModelInfo is one runtime model the Computer (or a declared static source)
// actually named. Fields the daemon did not send stay omitted.
type ModelInfo struct {
	ID                        string   `json:"id"`
	Label                     string   `json:"label"`
	SupportedReasoningEfforts []string `json:"supportedReasoningEfforts,omitempty"`
	DefaultReasoningEffort    string   `json:"defaultReasoningEffort,omitempty"`
	ServiceTiers              []string `json:"serviceTiers,omitempty"`
	DefaultServiceTier        string   `json:"defaultServiceTier,omitempty"`
	Verified                  string   `json:"verified,omitempty"`
}

// CatalogCapability is the Built-in proof that a live list came from that
// Computer's own versioned catalog. Absence is not success.
type CatalogCapability struct {
	ProtocolVersion int    `json:"protocolVersion"`
	Runtime         string `json:"runtime"`
	RuntimeVersion  string `json:"runtimeVersion"`
}

// ModelSet is a live catalog value.
type ModelSet struct {
	Models  []ModelInfo        `json:"models"`
	Default string             `json:"default,omitempty"`
	Catalog *CatalogCapability `json:"catalog,omitempty"`
}

// Outcome is the closed RuntimeModelSourceOutcome. Kind "error" always
// carries Retryable. Other kinds leave it unset.
type Outcome struct {
	Kind      string
	Value     *ModelSet
	Recovery  string
	Retryable bool
}

type outcomeJSON struct {
	Kind      string    `json:"kind"`
	Value     *ModelSet `json:"value,omitempty"`
	Recovery  string    `json:"recovery,omitempty"`
	Retryable *bool     `json:"retryable,omitempty"`
}

// MarshalJSON encodes the closed outcome. Retryable is present only for kind=error.
func (o Outcome) MarshalJSON() ([]byte, error) {
	payload := outcomeJSON{Kind: o.Kind, Value: o.Value, Recovery: o.Recovery}
	if o.Kind == "error" {
		retryable := o.Retryable
		payload.Retryable = &retryable
	}
	return json.Marshal(payload)
}

func errorOutcome() Outcome {
	return Outcome{Kind: "error", Retryable: true}
}

func outcomeFromSet(value ModelSet) Outcome {
	if len(value.Models) == 0 {
		return Outcome{Kind: "no_models"}
	}
	copied := value
	if copied.Models == nil {
		copied.Models = []ModelInfo{}
	}
	return Outcome{Kind: "live", Value: &copied}
}

// staticRuntimeModels is RUNTIME_MODELS for the declared closed sources.
// Verification is applied by ProjectRuntimeModelResult, matching
// getStaticRuntimeModelSourceSet.
var staticRuntimeModels = map[string]struct {
	verified string
	models   []ModelInfo
}{
	"claude": {verified: "launchable", models: []ModelInfo{
		{ID: "opus", Label: "Claude Opus"},
		{ID: "fable", Label: "Claude Fable"},
		{ID: "sonnet", Label: "Claude Sonnet"},
		{ID: "haiku", Label: "Claude Haiku"},
		{ID: "claude-opus-5-5", Label: "Claude Opus 5.5"},
		{ID: "claude-opus-5", Label: "Claude Opus 5"},
		{ID: "claude-opus-4-8", Label: "Claude Opus 4.8"},
		{ID: "claude-opus-4-7", Label: "Claude Opus 4.7"},
		{ID: "claude-opus-4-6", Label: "Claude Opus 4.6"},
		{ID: "claude-fable-5-1", Label: "Claude Fable 5.1"},
		{ID: "claude-fable-5", Label: "Claude Fable 5"},
		{ID: "claude-sonnet-5-5", Label: "Claude Sonnet 5.5"},
		{ID: "claude-sonnet-5", Label: "Claude Sonnet 5"},
		{ID: "claude-sonnet-4-6", Label: "Claude Sonnet 4.6"},
		{ID: "claude-haiku-4-5", Label: "Claude Haiku 4.5"},
	}},
	"copilot": {verified: "launchable", models: []ModelInfo{
		{ID: "gpt-5.4", Label: "GPT-5.4"},
		{ID: "gpt-5.2", Label: "GPT-5.2"},
		{ID: "claude-4-sonnet", Label: "Claude 4 Sonnet"},
		{ID: "claude-4.5-sonnet", Label: "Claude 4.5 Sonnet"},
	}},
	"gemini": {verified: "suggestion_only", models: []ModelInfo{
		{ID: "default", Label: "Configured Default / Auto", Verified: "suggestion_only"},
		{ID: "gemini-3.1-pro-preview", Label: "Gemini 3.1 Pro (Preview)"},
		{ID: "gemini-3-flash-preview", Label: "Gemini 3 Flash (Preview)"},
		{ID: "gemini-2.5-pro", Label: "Gemini 2.5 Pro"},
		{ID: "gemini-2.5-flash", Label: "Gemini 2.5 Flash"},
	}},
}

func staticSource(runtime string) (ModelSet, bool) {
	entry, ok := staticRuntimeModels[runtime]
	if !ok {
		return ModelSet{}, false
	}
	models := make([]ModelInfo, len(entry.models))
	for i, model := range entry.models {
		models[i] = model
		if models[i].Verified == "" {
			models[i].Verified = entry.verified
		}
	}
	return ModelSet{Models: models}, true
}

type wireModel struct {
	ID                        string   `json:"id"`
	Label                     string   `json:"label"`
	SupportedReasoningEfforts []string `json:"supportedReasoningEfforts"`
	DefaultReasoningEffort    string   `json:"defaultReasoningEffort"`
	ServiceTiers              []string `json:"serviceTiers"`
	DefaultServiceTier        string   `json:"defaultServiceTier"`
	Verified                  string   `json:"verified"`
}

func parseModelList(raw json.RawMessage, limit int) ([]ModelInfo, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return []ModelInfo{}, true
	}
	var items []json.RawMessage
	if json.Unmarshal(raw, &items) != nil {
		return nil, false
	}
	if len(items) > limit {
		return nil, false
	}
	models := make([]ModelInfo, 0, len(items))
	seen := make(map[string]struct{}, len(items))
	for _, item := range items {
		var probe map[string]json.RawMessage
		if json.Unmarshal(item, &probe) != nil {
			return nil, false
		}
		var model wireModel
		if json.Unmarshal(item, &model) != nil {
			return nil, false
		}
		if !validToken(model.ID) || strings.ContainsRune(model.Label, 0) {
			return nil, false
		}
		if _, dup := seen[model.ID]; dup {
			return nil, false
		}
		seen[model.ID] = struct{}{}
		info := ModelInfo{ID: model.ID, Label: model.Label}
		if _, ok := probe["supportedReasoningEfforts"]; ok {
			efforts, ok := validStringList(model.SupportedReasoningEfforts)
			if !ok {
				return nil, false
			}
			info.SupportedReasoningEfforts = efforts
		}
		if _, ok := probe["defaultReasoningEffort"]; ok {
			if !validToken(model.DefaultReasoningEffort) {
				return nil, false
			}
			info.DefaultReasoningEffort = model.DefaultReasoningEffort
		}
		if _, ok := probe["serviceTiers"]; ok {
			tiers, ok := validStringList(model.ServiceTiers)
			if !ok {
				return nil, false
			}
			info.ServiceTiers = tiers
		}
		if _, ok := probe["defaultServiceTier"]; ok {
			if !validToken(model.DefaultServiceTier) {
				return nil, false
			}
			info.DefaultServiceTier = model.DefaultServiceTier
		}
		if _, ok := probe["verified"]; ok {
			if model.Verified != "launchable" && model.Verified != "suggestion_only" {
				return nil, false
			}
			info.Verified = model.Verified
		}
		models = append(models, info)
	}
	return models, true
}

func validToken(value string) bool {
	return value != "" && strings.TrimSpace(value) == value && !strings.ContainsRune(value, 0)
}

func validStringList(values []string) ([]string, bool) {
	if len(values) == 0 {
		return nil, false
	}
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if !validToken(value) {
			return nil, false
		}
		if _, ok := seen[value]; ok {
			return nil, false
		}
		seen[value] = struct{}{}
	}
	return append([]string(nil), values...), true
}

func parseCatalog(raw json.RawMessage) (*CatalogCapability, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, true
	}
	var catalog CatalogCapability
	if json.Unmarshal(raw, &catalog) != nil {
		return nil, false
	}
	if catalog.ProtocolVersion != 1 || catalog.Runtime != "builtin" || strings.TrimSpace(catalog.RuntimeVersion) == "" || strings.TrimSpace(catalog.RuntimeVersion) != catalog.RuntimeVersion {
		return nil, true
	}
	return &catalog, true
}

// ProjectRuntimeModelResult maps a daemon machine:runtime_models:result onto
// the closed outcome. A typed outcome wins. The static claude/copilot/gemini
// catalogs are used only when an old daemon answers error:"unsupported" and
// did not send a typed outcome — never when the Computer is absent.
func ProjectRuntimeModelResult(raw json.RawMessage, runtime string, modelLimit int) Outcome {
	var msg struct {
		Outcome json.RawMessage `json:"outcome"`
		Models  json.RawMessage `json:"models"`
		Default *string         `json:"default"`
		Error   *string         `json:"error"`
	}
	if json.Unmarshal(raw, &msg) != nil {
		return errorOutcome()
	}
	if len(msg.Outcome) > 0 && string(msg.Outcome) != "null" {
		return projectTypedOutcome(msg.Outcome, modelLimit)
	}
	if msg.Error != nil {
		if *msg.Error == "unsupported" {
			if source, ok := staticSource(runtime); ok {
				return Outcome{Kind: "live", Value: &source}
			}
			return Outcome{Kind: "unsupported"}
		}
		return errorOutcome()
	}
	models, ok := parseModelList(msg.Models, modelLimit)
	if !ok {
		return errorOutcome()
	}
	value := ModelSet{Models: models}
	if msg.Default != nil && *msg.Default != "" {
		value.Default = *msg.Default
	}
	return outcomeFromSet(value)
}

func projectTypedOutcome(raw json.RawMessage, modelLimit int) Outcome {
	var probe struct {
		Kind      string          `json:"kind"`
		Value     json.RawMessage `json:"value"`
		Recovery  *string         `json:"recovery"`
		Retryable *bool           `json:"retryable"`
	}
	if json.Unmarshal(raw, &probe) != nil {
		return errorOutcome()
	}
	recovery := ""
	if probe.Recovery != nil {
		if strings.ContainsRune(*probe.Recovery, 0) {
			return errorOutcome()
		}
		recovery = *probe.Recovery
	}
	switch probe.Kind {
	case "missing_config", "no_models":
		return Outcome{Kind: probe.Kind, Recovery: recovery}
	case "unsupported":
		return Outcome{Kind: "unsupported"}
	case "error":
		retryable := true
		if probe.Retryable != nil {
			retryable = *probe.Retryable
		}
		return Outcome{Kind: "error", Retryable: retryable}
	case "live":
		var value struct {
			Models  json.RawMessage `json:"models"`
			Default *string         `json:"default"`
			Catalog json.RawMessage `json:"catalog"`
		}
		if len(probe.Value) == 0 || json.Unmarshal(probe.Value, &value) != nil {
			return errorOutcome()
		}
		models, ok := parseModelList(value.Models, modelLimit)
		if !ok {
			return errorOutcome()
		}
		set := ModelSet{Models: models}
		if value.Default != nil && *value.Default != "" {
			if strings.ContainsRune(*value.Default, 0) {
				return errorOutcome()
			}
			set.Default = *value.Default
		}
		if len(value.Catalog) > 0 && string(value.Catalog) != "null" {
			catalog, ok := parseCatalog(value.Catalog)
			if !ok {
				return errorOutcome()
			}
			set.Catalog = catalog
		}
		copied := set
		return Outcome{Kind: "live", Value: &copied}
	default:
		return errorOutcome()
	}
}
