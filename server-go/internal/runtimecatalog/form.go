package runtimecatalog

import (
	"regexp"
	"strings"
)

var bracketMinutes = regexp.MustCompile(`(?i)\[(\d+)m\]`)

// Issue is one form-definition problem (TS AgentCreateFormIssue).
type Issue struct {
	Code    string `json:"code"`
	Pointer string `json:"pointer"`
}

// FormOption is one select value. Provider rows set ProviderKind; model rows
// omit it. Reasoning fields are omitted unless the Computer declared them.
type FormOption struct {
	Value                     string   `json:"value"`
	Label                     string   `json:"label"`
	ProviderKind              string   `json:"providerKind,omitempty"`
	SupportedReasoningEfforts []string `json:"supportedReasoningEfforts,omitempty"`
	DefaultReasoningEffort    string   `json:"defaultReasoningEffort,omitempty"`
}

// SelectSource is a version-pinned select option source.
type SelectSource struct {
	ProtocolVersion int          `json:"protocolVersion"`
	RuntimeID       string       `json:"runtimeId"`
	SchemaVersion   string       `json:"schemaVersion"`
	SourceID        string       `json:"sourceId"`
	Pointer         string       `json:"pointer"`
	Kind            string       `json:"kind"`
	Options         []FormOption `json:"options"`
	DefaultValue    string       `json:"defaultValue"`
}

// DependentSource is a version-pinned dependent select option source.
type DependentSource struct {
	ProtocolVersion           int                     `json:"protocolVersion"`
	RuntimeID                 string                  `json:"runtimeId"`
	SchemaVersion             string                  `json:"schemaVersion"`
	SourceID                  string                  `json:"sourceId"`
	Pointer                   string                  `json:"pointer"`
	Kind                      string                  `json:"kind"`
	DependsOn                 string                  `json:"dependsOn"`
	OptionsByValue            map[string][]FormOption `json:"optionsByValue"`
	DefaultValueByValue       map[string]string       `json:"defaultValueByValue"`
	CustomValueAllowedByValue map[string]bool         `json:"customValueAllowedByValue"`
}

var builtinGatewayIDs = []string{"openai-compatible", "anthropic-compatible"}

func allBuiltinProviderIDs() []string {
	ids := make([]string, 0, len(builtinPresetProviders)+len(builtinGatewayIDs))
	for _, provider := range builtinPresetProviders {
		ids = append(ids, provider.ID)
	}
	ids = append(ids, builtinGatewayIDs...)
	return ids
}

func isGatewayProvider(id string) bool {
	for _, gateway := range builtinGatewayIDs {
		if gateway == id {
			return true
		}
	}
	return false
}

func providerDisplayName(id string) string {
	for _, provider := range builtinPresetProviders {
		if provider.ID == id {
			return provider.Label
		}
	}
	return humanizeProviderID(id)
}

// BuildBuiltinPiFormDefinition is the v2 Built-in Pi create form. Option
// values are not inlined; the Web loads them from the option-source route.
func BuildBuiltinPiFormDefinition() map[string]any {
	ref := BuiltinPiFormDefinitionRef()
	min1 := 1
	writeOnly := true
	return map[string]any{
		"protocolVersion": ref.ProtocolVersion,
		"runtimeId":       ref.RuntimeID,
		"schemaVersion":   ref.SchemaVersion,
		"dataSchema": map[string]any{
			"type":                 "object",
			"additionalProperties": false,
			"required":             []string{"providerId", "apiKey", "model"},
			"properties": map[string]any{
				"providerId":         stringField("Provider", &min1, "", nil),
				"apiKey":             stringField("API Key", &min1, "", &writeOnly),
				"baseUrl":            stringField("Base URL", &min1, "uri", nil),
				"supportsImageInput": map[string]any{"type": "boolean", "title": "Image input"},
				"model":              stringField("Model", &min1, "", nil),
				"envVars":            objectField("Environment Variables"),
			},
		},
		"uiSchema": map[string]any{
			"order":  []string{"providerId", "apiKey", "baseUrl", "supportsImageInput", "model", "envVars"},
			"layout": map[string]any{"advanced": []string{"/envVars"}},
			"visibility": []any{
				visibility("/baseUrl", "/providerId", builtinGatewayIDs),
				visibility("/supportsImageInput", "/providerId", builtinGatewayIDs),
			},
			"localization": map[string]any{
				"providerId": map[string]any{
					"label": "Provider",
					"hint":  "Built-in Pi is ready to use without local runtime setup. It uses the provider key entered here.",
				},
				"apiKey":             map[string]any{"label": "API Key", "placeholder": "sk-..."},
				"baseUrl":            map[string]any{"label": "Base URL", "placeholder": "https://gateway.example.com/v1"},
				"supportsImageInput": map[string]any{"label": "Supports image input", "hint": "Enable only when this gateway endpoint and model accept images."},
				"model":              map[string]any{"label": "Model", "placeholder": "Model ID"},
				"envVars":            map[string]any{"label": "Environment Variables", "hint": "These will be injected into the runtime command environment."},
			},
		},
		"capabilities": map[string]any{
			"providerKinds":     []string{"preset", "gateway"},
			"writeOnlyPointers": []string{"/apiKey"},
			"forbiddenPointers": []string{"/hostUserState"},
		},
		"optionSources": map[string]any{
			"provider": sourceRef(ref, "provider", "select", "/providerId", ""),
			"model":    sourceRef(ref, "model", "dependent_select", "/model", "/providerId"),
		},
	}
}

// BuildKimiSDKFormDefinition is the Kimi Code create form. Model values come
// from the Computer's live detect result, not this definition.
func BuildKimiSDKFormDefinition() map[string]any {
	ref := KimiSDKFormDefinitionRef()
	min1 := 1
	return map[string]any{
		"protocolVersion": ref.ProtocolVersion,
		"runtimeId":       ref.RuntimeID,
		"schemaVersion":   ref.SchemaVersion,
		"dataSchema": map[string]any{
			"type":                 "object",
			"additionalProperties": false,
			"required":             []string{"model"},
			"properties": map[string]any{
				"model":           stringField("Model", &min1, "", nil),
				"reasoningEffort": stringField("Thinking effort", &min1, "", nil),
				"envVars":         objectField("Environment Variables"),
			},
		},
		"uiSchema": map[string]any{
			"order":      []string{"model", "reasoningEffort", "envVars"},
			"layout":     map[string]any{"advanced": []string{"/envVars"}},
			"visibility": []any{},
			"localization": map[string]any{
				"model":           map[string]any{"label": "Model", "hint": "Models available from this computer's Kimi configuration."},
				"reasoningEffort": map[string]any{"label": "Thinking effort", "hint": "Available values are declared by the selected model."},
				"envVars":         map[string]any{"label": "Environment Variables", "hint": "These will be injected into the runtime command environment."},
			},
		},
		"capabilities": map[string]any{
			"providerKinds":     []string{},
			"writeOnlyPointers": []string{},
			"forbiddenPointers": []string{"/hostUserState"},
		},
		"optionSources": map[string]any{
			"model": sourceRef(ref, "model", "select", "/model", ""),
		},
	}
}

func stringField(title string, minLength *int, format string, writeOnly *bool) map[string]any {
	field := map[string]any{"type": "string", "title": title}
	if minLength != nil {
		field["minLength"] = *minLength
	}
	if format != "" {
		field["format"] = format
	}
	if writeOnly != nil {
		field["writeOnly"] = *writeOnly
	}
	return field
}

func objectField(title string) map[string]any {
	return map[string]any{
		"type":                 "object",
		"title":                title,
		"additionalProperties": map[string]any{"type": "string"},
	}
}

func visibility(pointer, whenPointer string, in []string) map[string]any {
	values := append([]string(nil), in...)
	return map[string]any{
		"pointer": pointer,
		"when":    map[string]any{"pointer": whenPointer, "in": values},
	}
}

func sourceRef(ref FormDefinitionRef, sourceID, kind, pointer, dependsOn string) map[string]any {
	body := map[string]any{
		"protocolVersion": ref.ProtocolVersion,
		"runtimeId":       ref.RuntimeID,
		"schemaVersion":   ref.SchemaVersion,
		"sourceId":        sourceID,
		"kind":            kind,
		"pointer":         pointer,
	}
	if dependsOn != "" {
		body["dependsOn"] = dependsOn
	}
	return body
}

// BuildBuiltinPiFormOptionSource is the unfiltered presentation catalog.
// sourceID is "provider" or "model"; anything else is absent.
func BuildBuiltinPiFormOptionSource(sourceID string) (any, bool) {
	ref := BuiltinPiFormDefinitionRef()
	switch sourceID {
	case "provider":
		ids := allBuiltinProviderIDs()
		options := make([]FormOption, 0, len(ids))
		for _, id := range ids {
			kind := "preset"
			if isGatewayProvider(id) {
				kind = "gateway"
			}
			options = append(options, FormOption{
				Value:        id,
				Label:        providerDisplayName(id),
				ProviderKind: kind,
			})
		}
		defaultValue := "deepseek"
		if len(builtinPresetProviders) > 0 {
			defaultValue = builtinPresetProviders[0].ID
		}
		return SelectSource{
			ProtocolVersion: ref.ProtocolVersion,
			RuntimeID:       ref.RuntimeID,
			SchemaVersion:   ref.SchemaVersion,
			SourceID:        sourceID,
			Pointer:         "/providerId",
			Kind:            "select",
			Options:         options,
			DefaultValue:    defaultValue,
		}, true
	case "model":
		optionsByValue := make(map[string][]FormOption, len(builtinPresetProviders)+len(builtinGatewayIDs))
		defaultByValue := make(map[string]string, len(builtinPresetProviders))
		customByValue := make(map[string]bool, len(builtinPresetProviders)+len(builtinGatewayIDs))
		for _, provider := range builtinPresetProviders {
			models := make([]FormOption, 0, len(provider.Models))
			for _, model := range provider.Models {
				models = append(models, FormOption{Value: model.ID, Label: model.Label})
			}
			optionsByValue[provider.ID] = models
			defaultByValue[provider.ID] = provider.Default
			customByValue[provider.ID] = false
		}
		for _, id := range builtinGatewayIDs {
			optionsByValue[id] = []FormOption{}
			customByValue[id] = true
		}
		return DependentSource{
			ProtocolVersion:           ref.ProtocolVersion,
			RuntimeID:                 ref.RuntimeID,
			SchemaVersion:             ref.SchemaVersion,
			SourceID:                  sourceID,
			Pointer:                   "/model",
			Kind:                      "dependent_select",
			DependsOn:                 "/providerId",
			OptionsByValue:            optionsByValue,
			DefaultValueByValue:       defaultByValue,
			CustomValueAllowedByValue: customByValue,
		}, true
	default:
		return nil, false
	}
}

// FilterBuiltinPiFormOptionSource keeps gateway rows and the preset models
// the Computer's catalog named. Model ids the registry does not contain are
// not added.
func FilterBuiltinPiFormOptionSource(source any, supported map[string]struct{}) any {
	switch typed := source.(type) {
	case SelectSource:
		if typed.Pointer != "/providerId" {
			return typed
		}
		options := make([]FormOption, 0, len(typed.Options))
		for _, option := range typed.Options {
			if option.ProviderKind == "gateway" || providerHasSupportedModel(option.Value, supported) {
				options = append(options, option)
			}
		}
		if options == nil {
			options = []FormOption{}
		}
		defaultValue := typed.DefaultValue
		kept := false
		for _, option := range options {
			if option.Value == defaultValue {
				kept = true
				break
			}
		}
		if !kept {
			defaultValue = ""
			if len(options) > 0 {
				defaultValue = options[0].Value
			}
		}
		typed.Options = options
		typed.DefaultValue = defaultValue
		return typed
	case DependentSource:
		if typed.Pointer != "/model" {
			return typed
		}
		optionsByValue := make(map[string][]FormOption, len(typed.OptionsByValue))
		for providerID, options := range typed.OptionsByValue {
			filtered := make([]FormOption, 0, len(options))
			for _, option := range options {
				if _, ok := supported[option.Value]; ok {
					filtered = append(filtered, option)
				}
			}
			if len(filtered) > 0 || typed.CustomValueAllowedByValue[providerID] {
				if filtered == nil {
					filtered = []FormOption{}
				}
				optionsByValue[providerID] = filtered
			}
		}
		defaultByValue := make(map[string]string, len(typed.DefaultValueByValue))
		for providerID, value := range typed.DefaultValueByValue {
			options := optionsByValue[providerID]
			if len(options) == 0 {
				continue
			}
			chosen := options[0].Value
			if _, ok := supported[value]; ok {
				chosen = value
			}
			defaultByValue[providerID] = chosen
		}
		customByValue := make(map[string]bool, len(optionsByValue))
		for providerID := range optionsByValue {
			customByValue[providerID] = typed.CustomValueAllowedByValue[providerID]
		}
		typed.OptionsByValue = optionsByValue
		typed.DefaultValueByValue = defaultByValue
		typed.CustomValueAllowedByValue = customByValue
		return typed
	default:
		return source
	}
}

func providerHasSupportedModel(providerID string, supported map[string]struct{}) bool {
	prefix := providerID + "/"
	for id := range supported {
		if strings.HasPrefix(id, prefix) {
			return true
		}
	}
	return false
}

// ValidateBuiltinPiDefinitionProjection checks the unfiltered definition
// against the embedded Pi registry. Drift fails the form route closed.
func ValidateBuiltinPiDefinitionProjection() []Issue {
	providerSource, ok := BuildBuiltinPiFormOptionSource("provider")
	if !ok {
		return []Issue{{Code: "definition_option_source_invalid", Pointer: "/optionSources"}}
	}
	modelSource, ok := BuildBuiltinPiFormOptionSource("model")
	if !ok {
		return []Issue{{Code: "definition_option_source_invalid", Pointer: "/optionSources"}}
	}
	providers, _ := providerSource.(SelectSource)
	models, _ := modelSource.(DependentSource)
	var issues []Issue
	if providers.Kind != "select" || providers.SourceID != "provider" || providers.Pointer != "/providerId" ||
		models.Kind != "dependent_select" || models.SourceID != "model" || models.Pointer != "/model" || models.DependsOn != "/providerId" {
		issues = append(issues, Issue{Code: "definition_option_source_topology_drift", Pointer: "/optionSources"})
	}
	ids := allBuiltinProviderIDs()
	if len(providers.Options) != len(ids) {
		issues = append(issues, Issue{Code: "definition_provider_registry_drift", Pointer: "/optionSources/provider/options"})
	} else {
		for i, id := range ids {
			option := providers.Options[i]
			kind := "preset"
			if isGatewayProvider(id) {
				kind = "gateway"
			}
			if option.Value != id || option.ProviderKind != kind || option.Label != providerDisplayName(id) {
				issues = append(issues, Issue{Code: "definition_provider_registry_drift", Pointer: "/optionSources/provider/options"})
				break
			}
		}
	}
	for _, provider := range builtinPresetProviders {
		served := models.OptionsByValue[provider.ID]
		if len(served) != len(provider.Models) || models.DefaultValueByValue[provider.ID] != provider.Default || models.CustomValueAllowedByValue[provider.ID] {
			issues = append(issues, Issue{Code: "definition_model_registry_drift", Pointer: "/optionSources/model/optionsByValue/" + provider.ID})
			continue
		}
		for i, model := range provider.Models {
			if served[i].Value != model.ID || served[i].Label != model.Label {
				issues = append(issues, Issue{Code: "definition_model_registry_drift", Pointer: "/optionSources/model/optionsByValue/" + provider.ID})
				break
			}
		}
	}
	for _, id := range builtinGatewayIDs {
		if len(models.OptionsByValue[id]) != 0 || models.CustomValueAllowedByValue[id] != true {
			issues = append(issues, Issue{Code: "definition_gateway_model_policy_drift", Pointer: "/optionSources/model/optionsByValue/" + id})
		}
		if _, present := models.DefaultValueByValue[id]; present {
			issues = append(issues, Issue{Code: "definition_gateway_model_policy_drift", Pointer: "/optionSources/model/defaultValueByValue/" + id})
		}
	}
	return issues
}

// ValidateKimiSDKDefinitionProjection checks the Kimi form topology.
func ValidateKimiSDKDefinitionProjection() []Issue {
	definition := BuildKimiSDKFormDefinition()
	sources, _ := definition["optionSources"].(map[string]any)
	source, _ := sources["model"].(map[string]any)
	if len(sources) != 1 || source["kind"] != "select" || source["sourceId"] != "model" || source["pointer"] != "/model" {
		return []Issue{{Code: "definition_option_source_topology_drift", Pointer: "/optionSources"}}
	}
	return nil
}

// BuildKimiSDKFormOptionSource projects a live Kimi detect result. Empty
// effort lists and efforts that do not contain the default are omitted.
func BuildKimiSDKFormOptionSource(models []ModelInfo, defaultModel string) SelectSource {
	ref := KimiSDKFormDefinitionRef()
	options := make([]FormOption, 0, len(models))
	ids := make(map[string]struct{}, len(models))
	for _, model := range models {
		option := FormOption{Value: model.ID, Label: model.Label}
		if efforts := validEfforts(model.SupportedReasoningEfforts); len(efforts) > 0 {
			option.SupportedReasoningEfforts = efforts
			if model.DefaultReasoningEffort != "" && containsString(efforts, model.DefaultReasoningEffort) {
				option.DefaultReasoningEffort = model.DefaultReasoningEffort
			}
		}
		options = append(options, option)
		ids[model.ID] = struct{}{}
	}
	defaultValue := ""
	if _, ok := ids[defaultModel]; ok {
		defaultValue = defaultModel
	} else if len(options) > 0 {
		defaultValue = options[0].Value
	}
	return SelectSource{
		ProtocolVersion: ref.ProtocolVersion,
		RuntimeID:       ref.RuntimeID,
		SchemaVersion:   ref.SchemaVersion,
		SourceID:        "model",
		Pointer:         "/model",
		Kind:            "select",
		Options:         options,
		DefaultValue:    defaultValue,
	}
}

func validEfforts(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" || strings.TrimSpace(value) != value || strings.ContainsRune(value, 0) {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func containsString(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}

// CatalogError is the Built-in catalog denial (TS BuiltInModelCatalogError).
type CatalogError struct {
	Code                  string
	Message               string
	RequestedModel        string
	DaemonVersion         *string
	ComputerVersion       *string
	CatalogRuntimeVersion string
	Recovery              string
}

func (e *CatalogError) Error() string { return e.Message }

// RequireBuiltinCatalog accepts only a live Built-in outcome that carries a
// versioned catalog capability. Anything else is unavailable, not an empty
// successful picker.
func RequireBuiltinCatalog(outcome Outcome, machineID string, daemonVersion, computerVersion *string) (map[string]struct{}, *CatalogError) {
	if outcome.Kind != "live" || outcome.Value == nil {
		return nil, unavailableCatalog(daemonVersion, computerVersion)
	}
	catalog := outcome.Value.Catalog
	if catalog == nil || catalog.ProtocolVersion != 1 || catalog.Runtime != "builtin" || strings.TrimSpace(catalog.RuntimeVersion) == "" {
		return nil, &CatalogError{
			Code:            "builtin_catalog_capability_required",
			Message:         "This Computer is too old to prove which Built-in models it supports. Upgrade the Computer before selecting or starting this model.",
			DaemonVersion:   daemonVersion,
			ComputerVersion: computerVersion,
			Recovery:        "upgrade_required",
		}
	}
	supported := make(map[string]struct{}, len(outcome.Value.Models))
	for _, model := range outcome.Value.Models {
		supported[model.ID] = struct{}{}
	}
	return supported, nil
}

func unavailableCatalog(daemonVersion, computerVersion *string) *CatalogError {
	return &CatalogError{
		Code:            "builtin_catalog_unavailable",
		Message:         "The target Computer's Built-in model catalog is unavailable. Retry after the Computer reconnects.",
		DaemonVersion:   daemonVersion,
		ComputerVersion: computerVersion,
		Recovery:        "retry",
	}
}

func humanizeProviderID(value string) string {
	replaced := bracketMinutes.ReplaceAllString(value, "-${1}m")
	parts := splitProviderTokens(replaced)
	labels := make([]string, 0, len(parts))
	for _, part := range parts {
		if part == "" {
			continue
		}
		labels = append(labels, formatProviderToken(part))
	}
	return strings.Join(labels, " ")
}

var providerTokenSpecial = map[string]string{
	"ai": "AI", "api": "API", "chatgpt": "ChatGPT", "claude": "Claude",
	"deepseek": "DeepSeek", "flash": "Flash", "gemini": "Gemini", "glm": "GLM",
	"gpt": "GPT", "kimi": "Kimi", "minimax": "MiniMax", "openai": "OpenAI",
	"opus": "Opus", "pro": "Pro", "sonnet": "Sonnet",
}

func formatProviderToken(token string) string {
	normalized := strings.ToLower(token)
	if special, ok := providerTokenSpecial[normalized]; ok {
		return special
	}
	if normalized == "b" || normalized == "m" {
		return strings.ToUpper(normalized)
	}
	if token == "" {
		return token
	}
	return strings.ToUpper(normalized[:1]) + normalized[1:]
}

func splitProviderTokens(value string) []string {
	return strings.FieldsFunc(value, func(r rune) bool {
		return r == '-' || r == '_' || r == '/'
	})
}
