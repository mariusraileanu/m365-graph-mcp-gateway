export type GraphCollectionResponse<T> = {
  value?: T[];
};

export type GraphSearchHit<TResource> = {
  resource?: TResource;
  summary?: string;
  hitId?: string;
};

export type GraphSearchResponse<TResource> = {
  value?: Array<{
    hitsContainers?: Array<{
      hits?: Array<GraphSearchHit<TResource>>;
    }>;
  }>;
};

export type GraphEmailAddress = {
  address?: string;
  name?: string;
};

export type GraphRecipient = {
  emailAddress?: GraphEmailAddress;
};

export type GraphMailBody = {
  content?: string;
  contentType?: string;
};

export type GraphMailMessage = {
  id?: string;
  subject?: string;
  from?: GraphRecipient;
  sentDateTime?: string;
  receivedDateTime?: string;
  isRead?: boolean;
  bodyPreview?: string;
  body?: GraphMailBody;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  conversationId?: string;
  webLink?: string;
};

export type GraphEventDateTime = {
  dateTime?: string;
  timeZone?: string;
};

export type GraphOrganizer = {
  emailAddress?: GraphEmailAddress;
};

export type GraphLocation = {
  displayName?: string;
};

export type GraphAttendeeStatus = {
  response?: string;
  time?: string;
};

export type GraphAttendee = {
  emailAddress?: GraphEmailAddress;
  type?: string;
  status?: GraphAttendeeStatus;
};

/** Minimal online-meeting shape nested inside a GraphEvent. */
export type GraphEventOnlineMeeting = {
  joinUrl?: string;
};

export type GraphResponseStatus = {
  response?: string;
  time?: string;
};

export type GraphEvent = {
  id?: string;
  subject?: string;
  start?: GraphEventDateTime;
  end?: GraphEventDateTime;
  organizer?: GraphOrganizer;
  attendees?: GraphAttendee[];
  location?: GraphLocation;
  isOnlineMeeting?: boolean;
  onlineMeeting?: GraphEventOnlineMeeting;
  webLink?: string;
  responseStatus?: GraphResponseStatus;
  bodyPreview?: string;
};

export type GraphFileAttachment = {
  '@odata.type': '#microsoft.graph.fileAttachment';
  name: string;
  contentType: string;
  contentBytes: string;
};
