INSERT INTO "feature_flags" (
	"key",
	"description",
	"enabled",
	"kill_switch",
	"randomization_unit",
	"default_enabled",
	"default_variant",
	"salt"
) VALUES (
	'omp_runtime_v0',
	'OMP (oh-my-pi) runtime rollout gate; stays off until the phase-1 series is accepted end to end',
	true,
	false,
	'server',
	false,
	NULL,
	'omp_runtime_v0'
) ON CONFLICT ("key") DO NOTHING;
