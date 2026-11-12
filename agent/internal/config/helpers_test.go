package config

// errorsOnly are the errors among the issues of a parse: a legacy spelling in a fixture adds `deprecated` warnings, which
// the tests that count problems are not about.
func errorsOnly(issues []Issue) []Issue {
	var out []Issue
	for _, is := range issues {
		if is.Severity == SeverityError {
			out = append(out, is)
		}
	}
	return out
}

// deprecationsOf are the deprecation warnings among the issues.
func deprecationsOf(issues []Issue) []Issue {
	var out []Issue
	for _, is := range issues {
		if is.Code == CodeDeprecated {
			out = append(out, is)
		}
	}
	return out
}
