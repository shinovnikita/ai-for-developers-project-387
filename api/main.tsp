import "@typespec/http";

using TypeSpec.Http;

@service(#{ title: "Календарь звонков" })
namespace CallCalendar;

model MeetingType {
  id: string;

  @minLength(1)
  @maxLength(80)
  name: string;

  @minLength(1)
  @maxLength(500)
  description: string;

  @minValue(5)
  @maxValue(120)
  durationMinutes: int32;
}

model CreateMeetingTypeInput {
  @doc("After trimming leading and trailing whitespace, the name must contain 1–80 characters.")
  name: string;

  @doc("After trimming leading and trailing whitespace, the description must contain 1–500 characters.")
  description: string;

  durationMinutes: MeetingType.durationMinutes;
}

model ApiError<Code extends string> {
  code: Code;
  message: string;
  fieldErrors?: Record<string>;
}

model MeetingTypeNameTakenError {
  code: "MEETING_TYPE_NAME_TAKEN";
  message: string;
  fieldErrors: { name: string };
}

@route("/api/meeting-types")
@get
op listMeetingTypes(): OkResponse & { @body body: MeetingType[] };

@route("/api/meeting-types")
@post
op createMeetingType(@body input: CreateMeetingTypeInput):
  CreatedResponse & { @body body: MeetingType }
  | BadRequestResponse & { @body body: ApiError<"VALIDATION_ERROR"> }
  | ConflictResponse & { @body body: MeetingTypeNameTakenError };

model Slot {
  startsAt: utcDateTime;
  endsAt: utcDateTime;
}

model AvailabilityDay {
  date: plainDate;
  slots: Slot[];
}

model Availability {
  timeZone: "Europe/Moscow";
  days: AvailabilityDay[];
}

model MeetingTypeNotFound {
  code: "MEETING_TYPE_NOT_FOUND";
  message: string;
}

@route("/api/meeting-types/{meetingTypeId}/availability")
@get
op getMeetingTypeAvailability(@path meetingTypeId: string):
  OkResponse & { @body body: Availability }
  | NotFoundResponse & { @body body: MeetingTypeNotFound };

model Meeting {
  id: string;
  meetingTypeId: MeetingType.id;
  meetingTypeName: MeetingType.name;

  @minLength(1)
  @maxLength(80)
  guestName: string;

  ...Slot;
}

model CreateMeetingInput {
  @minLength(1)
  meetingTypeId: string;

  @doc("UTC timestamp ending in Z.")
  startsAt: Slot.startsAt;

  @doc("After trimming leading and trailing whitespace, the guest name must contain 1–80 characters.")
  guestName: string;

  @format("uuid")
  attemptId: string;
}

model MeetingConfirmation {
  timeZone: "Europe/Moscow";
  meeting: Meeting;
}

@route("/api/meetings")
@post
op createMeeting(@body input: CreateMeetingInput):
  OkResponse & { @body body: MeetingConfirmation }
  | CreatedResponse & { @body body: MeetingConfirmation }
  | BadRequestResponse & { @body body: ApiError<"VALIDATION_ERROR"> }
  | NotFoundResponse & { @body body: MeetingTypeNotFound }
  | ConflictResponse & { @body body: ApiError<"SLOT_TAKEN" | "ATTEMPT_PAYLOAD_MISMATCH"> }
  | { @statusCode statusCode: 422; @body body: ApiError<"SLOT_UNAVAILABLE"> };

model UpcomingMeetings {
  timeZone: "Europe/Moscow";
  meetings: Meeting[];
}

@route("/api/meetings/upcoming")
@get
op listUpcomingMeetings(): OkResponse & { @body body: UpcomingMeetings };
