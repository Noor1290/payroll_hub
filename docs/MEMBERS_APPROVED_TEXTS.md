# Members screen: approved on-screen text

All on the Company profile, for admins of the selected company.

## The card

| Where | Text |
|---|---|
| Heading | Members |
| Under the heading | Who can open <company>. Admins see and change everything here; viewers can't see this card. |
| After your own email | (you) |
| Under each email | Added <date and time> |
| Role choices | Admin / Viewer |
| Button | Remove |
| Field | Add an existing user by email |
| Button | Add |
| Password gate locked | Confirm your password to add, change or remove members. They decide who sees national IDs and pay. |
| Heading | Changes |
| No changes yet | No changes have been made here yet. |

## The record of changes

- <who> added <email> as an admin. / as a viewer.
- <who> changed <email> from a viewer to an admin. / from an admin to a viewer.
- <who> removed <email>, who was a viewer. / who was an admin.

## Removing someone

| Where | Text |
|---|---|
| Title | Remove <email>? |
| Text | They will no longer be able to open <company>. You can add them again later. |
| Buttons | Cancel / Remove |

## Messages

| When | Title | Then |
|---|---|---|
| No account | No account uses this email | Create the account in Supabase first, then add it here. Nothing was changed. |
| Already in | This person is already a member | Change their role below. Nothing was changed. |
| Last admin | A company must keep at least one admin | Make someone else an admin first. Nothing was changed. |
| Yourself | You can't remove yourself or make yourself a viewer | Another admin of this company can do it. Nothing was changed. |
| Gone meanwhile | This person is no longer a member | Someone else may have changed it. Nothing was changed. |
| Same role | They already have that role | Nothing was changed. |
| Not an admin | Only an admin of this company can manage its members | Nothing was changed. |
| 0021 not run | Members aren't set up in the database yet | The owner needs to run supabase/migrations/0021_company_members.sql once in the Supabase SQL editor. Nothing has been lost. |
| Anything else | The dashboard could not reach the members | Check your connection and try again. Nothing was changed. |
| Not an email | Enter an email address such as name@example.com. | |

Small messages after a change: "<email> added to <company>", "<email> is now admin" or "viewer", "<email> removed from <company>".

## Delete company

The list of what would be deleted gains one line, when there is something to delete: "the record of changes to its members".

Approved by the owner on 1 November 2026. The hub has no automatic text check, so this list is the record of the approved wording.
