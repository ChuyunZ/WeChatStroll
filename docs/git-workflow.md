# Git Workflow

This document defines the Git branch, commit, pull request, review, and merge workflow for the WeChatStroll project.

## Branch Structure

We use the following branch structure:

- `main`: stable and demo-ready version
- `develop`: integrated development version
- `feature/...`: new features
- `fix/...`: bug fixes
- `docs/...`: documentation changes

Development should normally follow this flow:

```text
feature / fix / docs branch
          ↓
       develop
          ↓
        main
```

Feature development should not be done directly on `main` or `develop`.

---

## Branch Naming

Use lowercase branch names with words separated by hyphens.

### Feature branches

Format:

```text
feature/<feature-name>
```

Examples:

```text
feature/preference-questionnaire
feature/route-card
feature/map-route-display
feature/cloud-health-check
```

### Bug fix branches

Format:

```text
fix/<bug-name>
```

Examples:

```text
fix/location-permission
fix/route-card-layout
```

### Documentation branches

Format:

```text
docs/<document-name>
```

Examples:

```text
docs/git-workflow
docs/api-contract
docs/database-schema
```

---

## Creating a Branch

Before starting new work, switch to `develop` and make sure it is up to date.

```bash
git switch develop
git pull origin develop
```

Then create a new branch.

Example:

```bash
git switch -c feature/preference-questionnaire
```

Push the branch to GitHub:

```bash
git push -u origin feature/preference-questionnaire
```

---

## Commit Messages

Commit messages should clearly describe what the commit changes.

Recommended format:

```text
<type>: <description>
```

Common commit types:

- `feat`: new feature
- `fix`: bug fix
- `docs`: documentation
- `test`: tests
- `refactor`: code restructuring without changing behavior
- `chore`: project configuration or maintenance

Examples:

```text
feat: add walking preference questionnaire
feat: display route cards with mock data
fix: handle denied location permission
docs: add database schema
test: add route page test cases
```

---

## Pull Request Rules

Every feature, bug fix, or documentation change should normally be completed through a Pull Request.

### Pull Request target

Most Pull Requests should use:

```text
base: develop
compare: feature/... or fix/... or docs/...
```

Example:

```text
docs/git-workflow → develop
```

Do not normally merge feature branches directly into `main`.

---

## Pull Request Requirements

Before merging a Pull Request:

- The related GitHub Issue should be linked
- The other team member should review the Pull Request
- The code should run correctly
- Relevant tests should pass
- UI changes should include screenshots when possible
- Merge conflicts should be resolved
- The branch should be deleted after merging

For example, the Pull Request description can include:

```text
Related to #19
```

Use `Closes #<issue-number>` only when the Pull Request should close that issue after merging.

---

## Review Process

Because this project has two developers, the developer who creates the Pull Request should not be the only person reviewing it.

```text
Developer A creates branch
        ↓
Developer A implements changes
        ↓
Developer A creates Pull Request
        ↓
Developer B reviews
        ↓
Changes requested if necessary
        ↓
Pull Request approved
        ↓
Merge into develop
```

The same process applies when Developer B creates a Pull Request.

---

## Merging into Main

The `main` branch should contain stable and demo-ready code.

Features should normally first be merged into:

```text
develop
```

When the current version of `develop` is stable and ready for a milestone or demo, create a Pull Request:

```text
develop → main
```

Review the Pull Request before merging.

---

## Direct Push Rules

Do not directly push feature code to:

```text
main
```

New features should go through:

```text
feature branch → Pull Request → develop
```

The `main` branch should only receive reviewed and stable changes.

---

## Example Workflow

Suppose we are implementing the walking preference questionnaire.

### 1. Update `develop`

```bash
git switch develop
git pull origin develop
```

### 2. Create a branch

```bash
git switch -c feature/preference-questionnaire
```

### 3. Implement the feature

Make the required code changes.

### 4. Commit

```bash
git add .
git commit -m "feat: add walking preference questionnaire"
```

### 5. Push

```bash
git push -u origin feature/preference-questionnaire
```

### 6. Create a Pull Request

Create:

```text
feature/preference-questionnaire → develop
```

Link the related GitHub Issue.

### 7. Review

The other team member reviews the Pull Request.

### 8. Merge

After approval, merge the Pull Request into `develop`.

### 9. Delete the branch

Delete the feature branch after it has been successfully merged.

---

## Summary

Our standard development workflow is:

```text
GitHub Issue
    ↓
Create feature / fix / docs branch from develop
    ↓
Implement changes
    ↓
Commit
    ↓
Push branch
    ↓
Create Pull Request to develop
    ↓
Other team member reviews
    ↓
Merge
    ↓
Delete branch
```

`main` is reserved for stable versions of the project.
